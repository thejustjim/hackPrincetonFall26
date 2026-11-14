# TapTest

Pour water into one cup. TapTest measures pH, dissolved solids (TDS) and clarity, an AI agent
on the base station picks a filter, and the cup tips itself into ZeroWater or Brita. Pour the
clean water back in to retest. Results travel over a direct radio link (no WiFi or cell) to a
Raspberry Pi base station that maps every node around Princeton.

```
Uno (sensors, LCD, servo) --serial--> Feather ESP32 --ESP-NOW radio--> ESP32 receiver --USB--> Pi 4B gateway --WebSocket--> dashboard
                         <--AI cmd---                <--------------                <--------
```

## Folders
- `firmware/taptest_uno` - Arduino Uno: sensors, decision rule, tipping cup, LCD, radio out
- `firmware/taptest_node` - HUZZAH32 Feather on the tank: serial <-> ESP-NOW
- `firmware/taptest_receiver` - Inland ESP32 board at the base station: ESP-NOW <-> USB serial
- `gateway` - Python base station for the Pi (or a laptop): SQLite, anomaly score, Claude agent, REST + WebSocket
  - `investigator.py` - deepagents (LangChain) agent that writes a report after every `after` test
  - `fetch_reference.py` - pulls published USGS / NJ DEP conductance data into `reference.json`
- `web` - dashboard (Jim + Verna). The gateway serves this folder at http://<pi>:8000/

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
| verdict | `SAFE`, `HIGH_TDS` (>300 ppm), `CLOUDY` (clarity < 0.70), `PH_WARN` (outside 6.5-8.5) |
| filter | the tank's own rule: `NONE`, `ZEROWATER`, `BRITA` |
| rssi | radio signal strength, dBm |

The gateway adds `id`, `ts` (UTC ISO), `lat`, `lon`, `sim`, `anomaly` (0-1), and later
`ai_filter` + `explanation` once Claude answers.

Gateway to tank (AI decision, sent back over radio): `{"cmd":"filter","test":17,"filter":"BRITA"}`

## Gateway API (port 8000)
- `WS /ws` - live messages:
  - `{"type":"reading", ...all fields above}`
  - `{"type":"decision","id":..,"node":..,"test":..,"ai_filter":..,"explanation":..,"source":"claude"|"local_rule"}`
  - `{"type":"filters","filters":[...same as GET /api/filters]}` - after every tip and every retest
  - `{"type":"report","id":..,"node":..,"test":..,"filter":..,"report":"<markdown>","source":"deepagents","model":..}`
- `GET /api/nodes` - every node, location, latest reading (draw the map from this)
- `GET /api/readings?node=tank-01&limit=200` - history, newest first
- `GET /api/tests/{node}/{test}` - the before/after pair for the before/after card
- `GET /api/filters` - filter life per tank (see below)
- `POST /api/filters/{zerowater|brita}/replace` - a new filter went in: start its count over
- `GET /api/reference` - published Stony Brook / Millstone River / Lake Carnegie data (cached, works offline)
- `GET /api/reports?node=tank-01&limit=20` - investigator reports, newest first
- `POST /api/cmd?test=17&filter=BRITA` - manual override
- `GET /health`, `GET /docs` (interactive API docs)

## Filter life
Every time the cup tips into a filter, the gateway counts about 0.1 L through it (`LITERS_PER_TIP`).
- **ZeroWater**: `REPLACE` once an `after` test of ZeroWater-filtered water reads 6 ppm or more
  (ZeroWater's own "006" rule). It stays `REPLACE` until you call the replace endpoint.
- **Brita Elite**: rated for about 450 L. `LOW` at 90%, `REPLACE` at 100%.

## Investigator (deepagents)
After each `after` test, a LangChain deep agent (Claude Opus 5.5) calls `get_site_history`,
`get_nearby_nodes`, `get_filter_life` and `get_reference_data`, writes a short Markdown report
(result, context, filter, next step), and the gateway broadcasts it over `/ws`. It runs whenever
`ANTHROPIC_API_KEY` is set; `INVESTIGATOR=0` turns it off, `INVESTIGATOR_EFFORT=medium` makes it dig deeper.

## Published reference data
`python fetch_reference.py` pulls specific conductance for Stony Brook, Millstone River and Lake
Carnegie from the Water Quality Portal (waterqualitydata.us; USGS and NJ DEP samples), estimates
TDS = 0.65 x conductance, and caches it to `gateway/reference.json` (committed, so the demo works
offline). Re-run it to refresh. On the map, label these as published, not measured.

## Run the gateway
```
cp .env.example .env                  # then put the Anthropic key in .env (never commit it)
cd gateway
python3 -m venv .venv && . .venv/bin/activate   # Python 3.11+
pip install -r requirements.txt
MOCK=1 python gateway.py              # no hardware: fake tank + 12 simulated nodes
python gateway.py                     # real receiver on /dev/ttyUSB0 or /dev/ttyACM0
```
Without a key, the gateway uses the tank's local rule only. With one, Claude picks filters
(`"source":"claude"`) and the investigator writes reports.
`python mock.py` alone prints the exact receiver lines, so you can test a parser.

## Hardware bring-up order (Uno)
Upload `taptest_uno`, open Serial Monitor at 115200, type `h`.
1. LCD shows "TapTest ready". If blank, turn the blue pot on the I2C backpack; if still blank try address 0x3F.
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
