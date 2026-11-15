# Local radio protocol

These are source changes only. Nothing here flashes boards, moves a servo, starts a gateway, or changes the cloud database.

## One identity per reading

The Uno sends its existing JSON plus `ph_est: 1` when `PH_FROM_TDS` is enabled, or `0` for a calibrated probe. Clarity is still a relative index, not NTU.

The Feather validates the reading's `node` against its own `NODE_ID`, then appends:

- `session`: a fresh 16-character random boot identifier.
- `seq`: an unsigned 32-bit counter, advanced once per original UART reading.
- `sender_ms`: Feather uptime in milliseconds. This is not an absolute measurement timestamp.

Any transport retry must reuse the entire framed packet and its identity. A reboot starts a new session. Frames are checked before transmission and must fit below 250 bytes; malformed or overlong lines are dropped completely.

Set `NODE_ID` to the same value in the Uno and Feather, and use a different ID for each physical tank.

## Commands address one reading

The gateway replies with a complete flat JSON object, for example:

```json
{"cmd":"filter","node":"tank-01","test":5,"filter":"BRITA","session":"0123456789abcdef","seq":4}
```

The receiver learns each node's source MAC from validated readings and unicasts commands. An unknown node, a conflicting node ID on another MAC, a stale reading, or an invalid command is rejected. There is no broadcast fallback for commands. Its route table holds 16 nodes and is rebuilt from readings after restart. Duplicate or older sequence numbers cannot replace the current command target; a bounded cache also remembers four retired boot IDs per node.

The Feather accepts only a command for its latest **before** reading, matching node, exact test number, session and sequence. It consumes that decision once. The Uno independently requires its own node, exact test number, `cmd: filter`, and a recognized filter. In particular, test `5` cannot match test `50`. Escaped/nested JSON, duplicate keys, incomplete objects, unknown filters, and unaddressed commands cannot trigger actuation.

The Uno drains serial while preserving the original 2.5-second minimum hold and 2.5 + 8-second overall decision deadline. This prevents an early, longer addressed reply from overflowing SoftwareSerial's 64-byte receive buffer.

The new Feather requires the new gateway's echoed identity. Update the gateway and all relevant sketches together before testing. Old or missing identity fails closed to the tank's existing local-rule timeout; it does not restore broadcast actuation. This targeting prevents accidental cross-node commands; it does not add radio encryption or authenticate a hostile transmitter.

## Host checks

No boards or extra libraries are needed:

```sh
clang++ -std=c++11 -O1 -Wall -Wextra -Werror firmware/test_protocol.cpp -o /tmp/clarity-protocol-test
/tmp/clarity-protocol-test
cmp firmware/taptest_uno/ClarityProtocol.h firmware/taptest_node/ClarityProtocol.h
cmp firmware/taptest_uno/ClarityProtocol.h firmware/taptest_receiver/ClarityProtocol.h
```

The tests exercise the actual parser and identity matching used by all sketches, including two nodes with the same test number, out-of-order and replayed readings, recently retired boot sessions, stale commands, malformed/truncated/duplicate-key commands, and the maximum normal transport frame. Header copies intentionally sit inside each sketch folder so each sketch remains directly buildable in Arduino IDE without a custom library installation. Keep them identical.

These host checks do not replace compiling for the Uno and ESP32 or testing the real radio/servo chain. Arduino CLI and board cores were not installed on the review machine, and no board has been flashed by these changes.
