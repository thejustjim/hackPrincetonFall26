# Remote hardware ingestion

Run the gateway in `GATEWAY_MODE=remote` (or `REMOTE_INGEST=1`) with a private
`CONTROL_TOKEN`. Remote mode does not open serial, create a mock tank, or seed
synthetic tank history. `MOCK=1` is ignored in this mode. It uses a separate
`taptest-remote.db` by default; set `DB_PATH` to a persistent writable path.
`SIM_NODES=0` disables simulated peers; a positive value adds explicitly simulated
peers without creating tank readings. Do not copy an existing `.env`, database,
or saved API keys into a deployment.

For the initial hardware connection use `SIM_NODES=0`, `INVESTIGATOR=0`,
`RECORD=0`, `AI_TIMEOUT=6`, and explicitly empty `GOOGLE_API_KEY`,
`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `AI_PROVIDER`, `TIGER_DATABASE_URL`, and
`DATABASE_URL`. Startup fails if the token is missing. `/health` reports
`input_mode:"remote"`, `mock:false`, `remote_ingest:true`, and `ingest_ready:true`
once startup completes. GET routes and `/ws` are public reads. Existing control
routes still require `X-Clarity-Token`; HTTP ingress also accepts a Bearer token.

## Hardware request

Use the HTTPS gateway URL and token supplied privately by the operator. These
placeholders do not contain a working address or credential. The `session` must
be a stable boot nonce (1–32 letters, digits, `_` or `-`); `seq` is an unsigned
32-bit integer and must remain unchanged on an HTTP retry. Start a new session
when the pour counter resets or wraps. The known physical node is `tank-01`.

```sh
curl --fail-with-body --max-time 9 \
  'https://<gateway-host>/api/ingest' \
  -H 'Authorization: Bearer <private-control-token>' \
  -H 'Content-Type: application/json' \
  --data '{"node":"tank-01","session":"<boot-nonce>","seq":1,"test":1,"phase":"before","ph":7.2,"ph_est":true,"tds":185,"clarity":0.97,"verdict":"SAFE","filter":"NONE","ask":1}'
```

`ph_est:true` means pH is estimated from TDS; it is stored and labeled as such.
Send `ph_est:false` only for a calibrated independent pH measurement. An `after`
packet uses the same test/session and a new sequence. Optional `sender_ms` is
uptime, not UTC; optional timezone-qualified `measured_ts` is the measurement time.
The gateway assigns reception time and registered node location itself.

A successful reply is HTTP 200:

```json
{"ok":true,"duplicate":false,"reading_id":1,"node":"tank-01","test":1,"phase":"before","decision":{"filter":"NONE","source":"local_rule","explanation":null},"command":{"cmd":"filter","node":"tank-01","test":1,"filter":"NONE","session":"<boot-nonce>","seq":1}}
```

The response waits up to `min(AI_TIMEOUT+1,8)` seconds for the existing canonical
decision, seven seconds with the default timeout. `decision` and `command` may
be null while processing continues; decisions also arrive over `/ws`.
A command is returned only for an `ask:true` packet that still exactly matches
the latest raw-water reading. `ask:0` means hardware already acted and receives
no command. Retests, completed pours, stale readings, and a logical retry with
a changed sequence receive no command. Exact retries may return the same cached
command while it is current: the relay and firmware must enforce the full
node/session/seq/test identity, consume each command once, and discard late
commands. Preserve the hardware's local timeout fallback.

Use the serial relay in `gateway/relay.py` for the existing receiver. Do not
manually apply an old command after the receiver's decision window has closed.

One request accepts one JSON object, at most 4,096 bytes, with a five-second upload
timeout. Defaults allow a burst of 20 and refill at 120 requests/minute, globally
per gateway worker (`INGEST_BURST`, `INGEST_RATE_PER_MINUTE`). Responses are 401 for
missing/wrong credentials, 413 for large bodies, 415 for the wrong content type,
422 for invalid readings, 429 for rate limiting, and 503 for an unconfigured
token. Retry transient failures only within the hardware's remaining decision
window, always retaining the original sample identity.

## Local checks

```sh
PYTHONDONTWRITEBYTECODE=1 gateway/.venv/bin/python gateway/test_remote_ingest.py
PYTHONDONTWRITEBYTECODE=1 gateway/.venv/bin/python gateway/test_ingest.py
```

The HTTP tests use temporary SQLite, a fake token, no saved dotenv, stubbed model
calls, no serial device, and no cloud connection.
