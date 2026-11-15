# Hardware laptop → AWS gateway

This bridge runs on the laptop or Pi connected by USB to the **LoRa receiver**. The receiver firmware stays unchanged. AWS hosts the API; it cannot read the laptop's USB port itself. The rig keeps its local filter rule if the connection or AI is unavailable.

1. Pull/copy this local code onto the hardware laptop. Use Python 3.10+ and install only `pyserial` and `python-dotenv` if they are not already installed (`python3 -m pip install pyserial python-dotenv`). Do not run a second gateway/serial monitor against the same USB port.
2. Put these entries in the project's private local `.env`, or set environment variables. Replace placeholders privately; do not paste the token into chat, terminal commands, screenshots or Git.

   ```dotenv
   AWS_GATEWAY_URL=https://YOUR_APPROVED_AWS_GATEWAY_HOST
   CONTROL_TOKEN=YOUR_SHARED_PRIVATE_CONTROL_TOKEN
   SERIAL_PORT=/dev/cu.usbmodemYOUR_RECEIVER
   BAUD=115200
   ```

   On Linux/Pi the port is usually `/dev/ttyACM0` or `/dev/ttyUSB0`; on Windows use `COM3` (check the actual receiver port). The same private `CONTROL_TOKEN` must be set on AWS. AWS needs `REMOTE_INGEST=1` and a hardware node such as `tank-01`; see [REMOTE_INGEST.md](REMOTE_INGEST.md). Existing shell variables take precedence over `.env`.
3. After AWS HTTPS and its certificate are ready, run from the project folder:

   ```sh
   python3 gateway/relay.py
   ```

   Use `--port YOUR_PORT` or `--env /path/to/private.env` when needed. `python3 gateway/relay.py --help` does not open a port or make a request. Stop with Ctrl+C. Run the relay continuously during the pour.

The relay uploads original newline JSON with `Authorization: Bearer …`, retaining `session` and `seq` on HTTP retries. HTTPS verification stays on and redirects are rejected. It makes at most two attempts, with at most nine seconds per request and a 9.5-second total command window; late commands are discarded before serial output. This leaves the receiver's own final targeting/deadline check and the tank's local fallback in charge. The default AWS AI timeout is six seconds (the API waits seven), so keep that setting for this path.

Only a `before` reading with explicit `ask:1`/`true` can receive a command. The command must exactly match its `node`, `test`, `session` and integer `seq`, use `cmd:"filter"`, and name `NONE`, `BRITA` or `ZEROWATER`. After readings, pending responses, stale targets and buffered newer serial data never actuate. Exact duplicate responses are consumed once per relay process; the receiver independently consumes a targeted command once. A partial/failed serial write is **not** retried because it may already have reached the receiver. Keep one relay process per receiver.

Status lines contain no packet contents, URL or token. `uploaded` means the reading reached the API without an actionable command; `command-sent` means its command was written to USB, not confirmation of physical movement. `offline`/`late` leave the local rule active. `http-rejected` usually means the private token, firmware packet or server configuration needs checking; it is not retried. A temporary 429/5xx or transport error can be retried once within the window. `serial-write-failed` or a serial-open error requires checking the cable/port and closing other serial programs.

Offline verification (fake serial and HTTP only): `python3 gateway/test_relay.py`.
