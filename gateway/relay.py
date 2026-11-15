#!/usr/bin/env python3
"""Serial-to-HTTPS hardware bridge. Importing this module never opens a device/network."""
import argparse
from collections import OrderedDict
import json
import os
from pathlib import Path
import re
import time
from urllib import error, parse, request

MAX_PACKET = 4096
FILTERS = frozenset(('NONE', 'BRITA', 'ZEROWATER'))


class RelayHTTPError(Exception):
    def __init__(self, status):
        self.status = status


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the bearer secret to another destination.


def endpoint(base):
    url = parse.urlsplit(base.strip())
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path.rstrip('/') not in ('', '/api/ingest')):
        raise ValueError('AWS_GATEWAY_URL must be an HTTPS origin or its /api/ingest endpoint')
    return parse.urlunsplit((url.scheme, url.netloc, '/api/ingest', '', ''))


def unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError('duplicate JSON key')
        out[key] = value
    return out


def parse_json(body):
    def invalid_constant(value):
        raise ValueError('non-finite JSON value')
    return json.loads(body, object_pairs_hook=unique_object, parse_constant=invalid_constant)


def post_json(url, token, packet, timeout):
    body = json.dumps(packet, separators=(',', ':'), allow_nan=False).encode()
    req = request.Request(url, body, {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token}, method='POST')
    try:
        with request.build_opener(NoRedirect()).open(req, timeout=timeout) as response:
            data = response.read(16385)
            if len(data) > 16384:
                raise ValueError('response too large')
            return parse_json(data)
    except error.HTTPError as exc:
        raise RelayHTTPError(exc.code) from None


def uint(value, maximum=0xffffffff):
    return type(value) is int and 0 <= value <= maximum


def reading_identity(packet):
    if (not isinstance(packet, dict) or not isinstance(packet.get('node'), str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,23}', packet['node'])
            or not isinstance(packet.get('session'), str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', packet['session'])
            or not uint(packet.get('seq')) or not uint(packet.get('test'), 65535)
            or packet.get('phase') not in ('before', 'after')):
        return None
    return packet['node'], packet['test'], packet['session'], packet['seq']


def eligible(packet):
    return packet.get('phase') == 'before' and (packet.get('ask') is True or type(packet.get('ask')) is int and packet['ask'] == 1)


def targeted_command(packet, response):
    identity = reading_identity(packet)
    if not identity or not eligible(packet) or not isinstance(response, dict) or response.get('ok') is not True:
        return None
    if response.get('pending') or response.get('status') in ('pending', 'stale', 'rejected'):
        return None
    command = response.get('command')
    if (not isinstance(command, dict) or command.get('cmd') != 'filter'
            or command.get('filter') not in FILTERS or not uint(command.get('test'), 65535)
            or not uint(command.get('seq'))
            or tuple(command.get(k) for k in ('node', 'test', 'session', 'seq')) != identity):
        return None
    # Re-serialize only canonical firmware fields; no extra response text reaches UART.
    return {k: command[k] for k in ('cmd', 'node', 'test', 'filter', 'session', 'seq')}


class Relay:
    def __init__(self, serial, post, *, clock=time.monotonic, timeout=9.0, command_window=9.5):
        self.serial, self.post, self.clock = serial, post, clock
        self.timeout, self.command_window = min(timeout, 9.0), min(command_window, 9.5)
        self.consumed = OrderedDict()
        self.first_seen = OrderedDict()

    def process_line(self, raw):
        started = self.clock()
        if not isinstance(raw, (bytes, str)) or len(raw) > MAX_PACKET:
            return 'invalid'
        try:
            packet = parse_json(raw)
        except (ValueError, UnicodeError, TypeError):
            return 'invalid'
        identity = reading_identity(packet)
        if identity is None:
            return 'invalid'
        # A replayed UART packet must not restart the physical command window.
        if identity not in self.first_seen:
            self.first_seen[identity] = started
            if len(self.first_seen) > 4096:
                self.first_seen.popitem(last=False)
        started = self.first_seen[identity]
        response = None
        for attempt in range(2):
            remaining = self.command_window - (self.clock() - started)
            if remaining <= 0:
                return 'late'
            try:
                response = self.post(packet, timeout=min(self.timeout, remaining))
                # A pending first response may be retried once with the same identity.
                if attempt == 0 and isinstance(response, dict) and response.get('pending'):
                    continue
                break
            except RelayHTTPError as exc:
                if exc.status != 429 and not 500 <= exc.status <= 599:
                    return 'http-rejected'
            except (OSError, TimeoutError, ValueError):
                pass  # No body, token, URL or exception text is ever logged.
        if response is None:
            return 'offline'
        command = targeted_command(packet, response)
        if command is None:
            return 'uploaded' if isinstance(response, dict) and response.get('ok') is True else 'rejected-response'
        if identity in self.consumed:
            return 'duplicate-command'
        if self.clock() - started >= self.command_window:
            return 'late'
        # New serial data may supersede this pour. Receiver firmware is the final
        # identity/deadline guard too, but this bridge acts conservatively.
        if getattr(self.serial, 'in_waiting', 0):
            return 'superseded'
        wire = (json.dumps(command, separators=(',', ':')) + '\n').encode('ascii')
        self.consumed[identity] = None  # Consume before a possibly partial/failed UART write.
        if len(self.consumed) > 4096:
            self.consumed.popitem(last=False)
        try:
            written = self.serial.write(wire)
            return 'command-sent' if written == len(wire) else 'serial-write-failed'
        except (OSError, TimeoutError):
            return 'serial-write-failed'


class PacketReader:
    """Bounded buffer handles serial timeouts mid-line and drains overlong frames."""
    def __init__(self, serial):
        self.serial, self.buffer, self.dropping = serial, bytearray(), False

    def poll(self):
        chunk = self.serial.read_until(b'\n', MAX_PACKET + 1)
        if not chunk:
            return None
        if not self.dropping:
            self.buffer.extend(chunk)
            if len(self.buffer) > MAX_PACKET:
                self.buffer.clear()
                self.dropping = True
        if not chunk.endswith(b'\n'):
            return None
        value = None if self.dropping else bytes(self.buffer)
        self.buffer.clear()
        self.dropping = False
        return value


def main(argv=None):
    parser = argparse.ArgumentParser(description='Forward receiver JSON to the HTTPS AWS gateway; relay only exactly targeted, timely filter commands.')
    parser.add_argument('--port', help='Receiver USB serial port; alternatively SERIAL_PORT in .env')
    parser.add_argument('--baud', type=int, default=None, help='Default: BAUD or 115200')
    parser.add_argument('--env', default=str(Path(__file__).resolve().parents[1] / '.env'), help='Local environment file; values are never printed')
    args = parser.parse_args(argv)
    try:
        from dotenv import load_dotenv
        load_dotenv(args.env, override=False)
        url = endpoint(os.getenv('AWS_GATEWAY_URL', ''))
        token = os.getenv('CONTROL_TOKEN', '').strip()
        port = args.port or os.getenv('SERIAL_PORT', '')
        baud = args.baud or int(os.getenv('BAUD', '115200'))
        if not token or not port or not 1 <= baud <= 4000000:
            raise ValueError('Set CONTROL_TOKEN, AWS_GATEWAY_URL and SERIAL_PORT (or --port)')
        import serial
    except (ImportError, ValueError):
        parser.exit(2, 'Relay configuration missing/invalid. Check the handoff guide; no values are displayed.\n')
    try:
        with serial.Serial(port, baud, timeout=0.25, write_timeout=1) as device:
            relay = Relay(device, lambda packet, timeout: post_json(url, token, packet, timeout))
            reader = PacketReader(device)
            print('Hardware relay ready. Keep this process open; local device fallback remains active.', flush=True)
            while True:
                line = reader.poll()
                if line is not None:
                    print('relay: ' + relay.process_line(line), flush=True)
    except KeyboardInterrupt:
        return 0
    except (OSError, serial.SerialException):
        parser.exit(1, 'Serial connection unavailable. Close other serial monitors and check the receiver connection.\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
