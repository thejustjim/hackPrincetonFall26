# Clarity

*What you deserve.*

Pour water into one cup. Clarity measures pH, dissolved solids (TDS) and clarity (shown as transparency on the dashboard), an AI agent
on the base station picks a filter, and the cup tips itself into ZeroWater or Brita. Pour the
clean water back in to retest. Results travel over a direct radio link (no WiFi or cell) to a
Raspberry Pi base station that stores every node's readings and serves the dashboard.

```
Uno (sensors, LCD, servo) --serial--> Feather ESP32 --ESP-NOW radio--> ESP32 receiver --USB--> Pi 4B gateway --WebSocket--> dashboard
                         <--AI cmd---                <--------------                <--------
```

## Folders
- `firmware/taptest_uno` - Arduino Uno: sensors, decision rule, tipping cup, LCD, radio out
- `firmware/taptest_node` - HUZZAH32 Feather on the tank: serial <-> ESP-NOW
- `firmware/taptest_receiver` - Inland ESP32 board at the base station: ESP-NOW <-> USB serial
- `gateway` - Python base station for the Pi (or a laptop): SQLite, anomaly score, Claude agent, REST + WebSocket
  - `analysis.py` - layered detection: sensor checks, each node's own baseline and control charts, peer comparison
  - `investigator.py` - deepagents (LangChain): a lead agent and five specialists that write a report after every `after` test
  - `guidance.json` - the short guidance notes the maintenance agent searches
  - `fetch_reference.py` - pulls published USGS / NJ DEP conductance data into `reference.json`
  - `cloud.py` - copies everything to Tiger Cloud (TimescaleDB on AWS) when there is internet
- `web` - two pages, served by the gateway at http://<pi>:8000/:
  - `/demo/` - the live view: the latest cup, the notes around it, then the full account below.
    The dropper over the glass holds the latest pour as it read before filtering. If that pour was
    sent through a filter, a funnel swings in, catches the drop and lets a clear one through; water
    that read in range falls straight in.
  - `/pitch/` - the pitch. It opens on black with one brown drop caught by the filter, runs through the slides (scroll, swipe or
    arrow keys; `End` jumps to the last one), and scrolling past the last slide lands on `/demo/`.
    There is no way back up from the demo; reload `/pitch/` to start again.
  - Slides are in `web/pitch/slides.html`. The pitch is drawn over the demo page, so both are one document.
  - With no gateway reachable (static hosting, or `?demo`) the pages run on built-in sample data in the
    same shapes, labelled as sample data; `?api=http://<pi>:8000` points them at another gateway.

## Data format
The receiver prints one JSON object per line at 115200 baud:
```
{"node":"tank-01","test":17,"phase":"before","ph":7.21,"tds":482,"clarity":0.83,"verdict":"HIGH_TDS","filter":"ZEROWATER","rssi":-61}
```
| field | meaning |
|---|---|
| node | device id (`tank-01` real, `sim-01`... simulated) |
| test | pour number; the `before` and `after` readings of one pour share it |
| phase | `before` (first pour) or `after` (retest after filtering) |
| ph | 0-14, expect 5.5-9 |
| tds | ppm, 0-1000 (sensor tops out near 1000) |
| clarity | 0-1, 1 = as clear as clean water |
| verdict | `SAFE`, `HIGH_TDS` (>300 ppm), `CLOUDY` (clarity < 0.70), `PH_WARN` (outside 6.5-8.5). `SAFE` only means these three readings are in range; the pages show it as "In range". Nothing here tests for lead, bacteria or any specific contaminant. |
| filter | the tank's own rule: `NONE`, `ZEROWATER`, `BRITA` |
| rssi | radio signal strength, dBm |

The gateway adds `id`, `ts` (UTC ISO), `lat`, `lon`, `sim`, `anomaly` (0-1), and later
`ai_filter` + `explanation` once Claude answers.

Lines are checked before they are stored: the node must be one the gateway knows (`ALLOW_UNKNOWN_NODES=1`
lifts that), and the phase, verdict and number ranges must be valid. Anything else is dropped with a
logged reason.

Gateway to tank (AI decision, sent back over radio): `{"cmd":"filter","test":17,"filter":"BRITA"}`

## Gateway API (port 8000)
- `WS /ws` - live messages:
  - `{"type":"reading", ...all fields above}`
  - `{"type":"decision","id":..,"node":..,"test":..,"ai_filter":..,"explanation":..,"source":"claude"|"local_rule"}`
  - `{"type":"filters","filters":[...same as GET /api/filters]}` - after every tip and every retest
  - `{"type":"report","node":..,"test":..,"summary":"..","findings":[..],"actions":[..],"filter":..,"source":"rules"|"deepagents","model":..,`
    `"kind":"local_event","kind_words":"..","severity":0|1|2,"severity_words":"..","checks":{...GET /api/analysis},"sections":[{"agent","title","text"}],"notice":".."}`
- `GET /api/nodes` - every node, location, latest reading
- `GET /api/readings?node=tank-01&limit=200` - history, newest first
- `GET /api/tests/{node}/{test}` - the before/after pair for the before/after card
- `GET /api/filters` - `[{"filter":"ZEROWATER","liters":3.2,"last_after_tds":8,"status":"OK"|"REPLACE_SOON"|"REPLACE", ...}]` (see below)
- `POST /api/filters/{zerowater|brita}/replace` - a new filter went in: start its count over (a control, see below)
- `GET /api/reference` - `[{"site":"Stony Brook","lat":..,"lon":..,"tds_est":109,"date":"2023-07-27","source":"NJ DEP"|"USGS", ...}]`,
  the latest published sample per site plus `typical_tds_est` and `history` (cached, works offline)
- `GET /api/reports?node=tank-01&limit=20` - reports, newest first, same shape as the `/ws` message
- `GET /api/analysis?node=tank-01&test=17` - the layered checks for one raw-water reading (the node's latest without `test`)
- `POST /api/cmd?test=17&filter=BRITA` - manual override (a control, see below)
- `GET /api/cloud` - the cloud copy: on or off, connected, rows sent, rows waiting
- `GET /api/cloud/rollup?node=tank-01&hours=24` - 5-minute buckets for one node, read back from the cloud database
- `GET /health`, `GET /docs` (interactive API docs)

**Controls.** The two `POST` endpoints move hardware or reset counters, so they are not open to the network.
By default only the machine running the gateway can call them. To use them from another device, set
`CONTROL_TOKEN` in `.env` and send it as the `X-Clarity-Token` header; the demo page asks for it once and
remembers it in that browser. `GET /health` reports which mode is on (`"control":"local"` or `"token"`).

## Filter life
Every time the cup tips into a filter, the gateway counts about 0.1 L through it (`LITERS_PER_TIP`).
- **ZeroWater**: `REPLACE` once an `after` test of ZeroWater-filtered water reads 6 ppm or more
  (ZeroWater's own "006" rule). It stays `REPLACE` until you call the replace endpoint.
- **Brita Elite**: rated for about 450 L. `REPLACE_SOON` at 90%, `REPLACE` at 100%.

## Layered detection (`analysis.py`)
A new sensor has almost no labelled data, so detection is statistics, in three layers, worked out
by plain code before any model is asked:

1. **Sensor checks.** Is the sensor believable? Out of range, stuck on one value, reading zero on
   unfiltered water, or trending slowly one way. A sensor fault is not a water event.
2. **The node's own baseline.** Robust z-scores (median and MAD) against the node's own earlier
   pours; EWMA and CUSUM control charts for small shifts that persist; one multivariate
   (Mahalanobis) distance across pH, dissolved solids and transparency.
3. **Peer comparison.** Did the neighbours move the same way? Regional if at least two nearby
   nodes, and at least half of them, did. Otherwise local.

Then one verdict (`normal`, `sensor_fault`, `local_event`, `regional_shift`, `persistent_shift`)
with a severity (0 no action, 1 worth a second look, 2 act on it) and the evidence as sentences
that carry their numbers. `GET /api/analysis` returns all of it.

What it does not do: there is no pipe network or hydraulic model behind this, so nothing is traced
to a pipe segment; the neighbours are simulated nodes, and say so; there is no temperature sensor,
so baselines are not temperature-adjusted; and no machine-learning model is involved. The control
chart settings were chosen on simulated quiet data (about 3 false alarms per 1,000 pours).

`python test_analysis.py` checks it (20 checks, no hardware or key needed).

## Investigator (deepagents)
Every `after` test gets a report at once, written from the checks above by fixed rules
(`"source":"rules"`), so the page never waits on a model and still has a report with no key or
no internet.

When `ANTHROPIC_API_KEY` is set, a LangChain deep agent (Claude Opus 5.5) then writes a fuller
one (`"source":"deepagents"`), which takes the first one's place on the page. The lead agent
hands the case to five specialists at once through deepagents' `task` tool, each with only its
own tools:

| Specialist | Question | Tools |
|---|---|---|
| `sensor-health` | Can the sensor be believed? | `get_sensor_checks` |
| `analyst` | Is this unusual for this site? | `get_baseline`, `get_site_history`, `query_readings` (one read-only SQL `SELECT`) |
| `network` | Local or regional? What is published nearby? | `get_peer_comparison`, `get_nearby_nodes`, `get_reference_data` |
| `maintenance` | Filter life and upkeep | `get_filter_life`, `search_guidance` (keyword search over `guidance.json`) |
| `comms` | A short notice for the people who use this water | `get_notice_templates` |

The agents explain and decide what to do next; they do not compute. Every number comes from a
tool, and the verdict and severity come from `analysis.py`, not from a model. The notice is
filled in from fixed templates, always ends with what Clarity cannot detect, is discarded for
the fixed version if a model's draft drops that sentence, and is only shown: nothing sends it.

`INVESTIGATOR=0` turns the agents off, `INVESTIGATOR_EFFORT=medium` makes them dig deeper, and
`INVESTIGATOR_SUBAGENT_MODEL` gives the specialists a different model from the lead.

`python test_swarm.py` drives the lead and all five specialists with scripted stand-in models
(no key needed): it shows the delegation, the tool wiring, the read-only SQL guard and the
fallback to the rule-written report. It does not show what Claude would write; that needs a key.

## Published reference data
`python fetch_reference.py` pulls specific conductance for Stony Brook, Millstone River and Lake
Carnegie from the Water Quality Portal (waterqualitydata.us; USGS and NJ DEP samples), estimates
TDS = 0.65 x conductance, and caches it to `gateway/reference.json` (committed, so the demo works
offline). Re-run it to refresh. Wherever they are shown, label these as published, not measured.

## Cloud copy (Tiger Cloud: TimescaleDB on AWS)
The base station stores every reading in SQLite and serves the pages itself, so it needs no internet.
When it has some, it also copies everything to a cloud Postgres, so the data can be read from anywhere
and several base stations can share one database.

```
radio -> gateway -> SQLite on the Pi (source of truth) -> outbox -> Tiger Cloud
```
- SQLite triggers note each new or changed row in an outbox. A background thread sends them in batches
  and clears the outbox only after the cloud has committed them. With no internet the outbox grows and
  drains when the link is back; nothing is lost and nothing is sent twice (the inserts are upserts).
- In the cloud: `readings` is a TimescaleDB hypertable, `readings_5min` is a continuous aggregate
  (per node, per 5 minutes), old chunks are compressed after 7 days, and `nodes` and `reports` are
  ordinary tables you can join to. Every row says whether it is measured, simulated or from the mock.
- On plain Postgres the same code works with ordinary tables.

Set it up on your own AWS account (one command):
```
aws login                         # or: aws configure
deploy/aws-timescale.sh up        # one t3.small running TimescaleDB with TLS; about 3 cents an hour
cd gateway && python cloud.py check
```
The script makes a security group that lets in port 5432 only (no SSH), one Amazon Linux server
running the `timescale/timescaledb` container, and an Elastic IP, then writes
`TIGER_DATABASE_URL` into `.env` with a random password it never prints. Port 5432 is open to
any address by default so the Pi works from any network, protected by that password and TLS;
set `ALLOW_CIDR=<your address>/32` to narrow it. `deploy/aws-timescale.sh down` deletes all of it.

Or use a managed service:
1. Create a service at Tiger Cloud (pick an AWS region) and copy its connection string.
2. Put it in `.env` as `TIGER_DATABASE_URL=postgres://...` (it contains a password: never commit it).
3. `python cloud.py check` creates the tables and says what it found. Then start the gateway as usual;
   the first run also sends the history already on the Pi.
4. `python cloud.py rollup` prints the last hours from the continuous aggregate. `GET /api/cloud` shows
   rows sent and waiting, and the demo page says the same under Network.

## Run the gateway
```
cp .env.example .env                  # then put the Anthropic key in .env (never commit it)
cd gateway
python3 -m venv .venv && . .venv/bin/activate   # Python 3.11+
pip install -r requirements.txt
MOCK=1 python gateway.py              # no hardware: fake tank + 12 simulated nodes
python gateway.py                     # real receiver, found automatically
```
`requirements.lock.txt` has the exact versions this was tested with (`pip install -r requirements.lock.txt`).

The gateway looks for the receiver's USB serial port itself, trying USB-serial adapters (the ESP32
receiver) before boards like the Uno. If more than one is plugged in it says which it picked; set
`SERIAL_PORT=/dev/...` to choose.
Without a key, the gateway uses the tank's local rule and writes each report from its own checks.
With one, Claude picks filters (`"source":"claude"`) and the investigator's agents write the reports.
`python mock.py` alone prints the exact receiver lines, so you can test a parser.

## Hardware bring-up order (Uno)
Upload `taptest_uno`, open Serial Monitor at 115200, type `h`.
1. LCD shows "Clarity ready". If blank, turn the blue pot on the I2C backpack; if still blank try address 0x3F.
2. `v` prints raw values. TDS in tap water should read roughly 50-300 ppm.
3. pH: probe in the 6.86 buffer, wait 1 min, type `a6.86`. Rinse, 4.00 buffer, type `b4.00`. `m` should now read close to the buffer.
4. Clarity: clean water in the cup, type `c` (or long-press the button). `m` should show clarity near 1.00; tea should drop well below 0.70.
5. Servo: type `s1500` and watch. If it creeps, try `s1490`, `s1510`... until still. `l` / `r` jog. `L` / `R` run a full tip. If left goes right, set `LEFT_SIGN 1`. If it does not come fully back upright, adjust `k0.9` / `k1.1`.
6. RGB colours wrong or inverted: set `COMMON_ANODE 1`.

## Radio bring-up
1. Upload `taptest_node` to the HUZZAH32 (board "Adafruit ESP32 Feather"), `taptest_receiver` to the Inland ESP32 ("ESP32 Dev Module"; hold BOOT if upload hangs).
2. Receiver Serial Monitor at 115200 should print `{"type":"receiver_ready"}`, then a line every time the Uno finishes a test.
3. After it works, set `USE_LR 1` in both sketches for long-range mode and do a range walk.

---

## Working vision: affordable water monitoring that leads to action

Build an affordable system that measures water conditions, makes changes understandable across locations and time, and helps people decide what to do next. Demonstrate it through a small sensing device, a dashboard, and sensor-guided filter selection.

This is a synthesis of the discussion's working direction. The group has not fully resolved its intended customer or how much treatment the system should perform.

### The purpose

The original motivation was broader access to frequent water monitoring, particularly for communities with limited infrastructure or cellular coverage. Ethan described the value as collecting approximate readings across many places and times, spotting unusual patterns, and directing experts toward potential problems. That network ambition remains important to the concept's identity.

### How the concepts connect

**Sensing provides the evidence.** The proposed device measures pH, dissolved solids/conductivity, and optical indicators of color or cloudiness. These readings describe particular water properties; the discussion does not establish reliable identification of every contaminant.

**The dashboard makes readings useful.** The latest consolidated plan proposes live gauges, measurement history, before-and-after comparisons, and a 3D Princeton map. It also proposes combining device readings with published water data and approximately 15 clearly labeled simulated nodes.

**Filter selection connects measurement to action.** The hardware direction evolved toward a small array that selects a filter path using a servo. Bharath preferred two slots over three to keep the build manageable, and Jim accepted that choice. Later planning replaced pumped flow with gravity.

**AI explains the results.** The software plan gives AI a concrete role as an explainer alongside readings and history. The discussion leaves the model, its validation, and its authority over physical decisions unresolved.

Together, these form one intended experience: **measure → interpret → choose an action → compare the result**. The hardware produces evidence; the interface explains it; the filtration demonstration shows a possible response.

### Where the direction became clearer

**The group supported pursuing a physical demonstration.** The prototype's communications also changed from planned LoRa hardware to ESP-NOW because the LoRa parts were unavailable. That practical substitution leaves the original long-range network ambition to be demonstrated separately.

**The maintenance claim was challenged.** Ethan pointed out that filters still need replacement; Jim said he thought the earlier maintenance-free premise had been dropped. Bharath subsequently framed the benefit as choosing filters according to the device's readings. The emerging value is less testing and decision burden, with replacement still required.

**Autonomous detection and filtration were described as a future goal.** The current design is a small demonstration of that ambition; the discussion does not verify successful autonomous operation.

### The questions that still affect the vision

- **Who is the primary user?** The earlier direction serves communities and municipal monitoring. Jim later suggested a possible shift toward homeowners, while Ethan still understood the device as belonging in water mains. That shift was raised as a question.
- **What is the primary intervention?** Flagging anomalies for experts, recommending replacement filters, and automatically routing water through filters are related but distinct promises.
- **What can the evidence support?** Sensor interpretation, filter-selection logic, and before-and-after performance still need demonstration. The map should distinguish measured, published, and simulated data.

### Recommended focus for the first demonstration

Show one complete, understandable sequence: test a sample, display its readings, explain the supported finding, select a filter path, and compare the subsequent measurement. Use the map to show how that same process could extend across locations.

Keep affordable monitoring and informed action at the center. Let autonomous treatment and wider deployment remain the longer-term vision.
