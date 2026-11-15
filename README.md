# Clarity

*What you deserve.*

Presenting it? `DEMO.md` is the run-sheet: what to have ready, the two minutes, and what a judge will ask.

Pour water into one cup. Clarity measures dissolved solids (TDS) and clarity (shown as transparency on the dashboard), and for now
estimates pH from them. The tank's own rule decides whether the cup needs the filter, or for close calls an AI model on the base
station does, and the cup tips itself into the Brita (the rig has one filter). Pour the
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
- `gateway` - Python base station for the Pi (or a laptop): SQLite, layered detection, an AI agent (Gemini or Claude), REST + WebSocket
  - `analysis.py` - layered detection: sensor checks, each node's own baseline and control charts, peer comparison
  - `investigator.py` - deepagents (LangChain): a lead agent and five specialists that write a report after every `after` test
  - `fetch_guidance.py`, `guidance.py` - build and search an index of EPA and AWWA documents for the maintenance agent
  - `guidance.json` - the team's own short notes (the filter makers' rules), searched alongside
  - `fetch_reference.py` - pulls published USGS / NJ DEP conductance data into `reference.json`
  - `cloud.py` - copies everything to Tiger Cloud (TimescaleDB on AWS) when there is internet
- `web` - four pages, served by the gateway at http://<pi>:8000/:
  - `/demo/` - the live view: the latest cup, the notes around it, then the full account below.
    The full account's before and after glasses are the same 3D glass as the hero's (`plate3d.js`),
    drawn over flat ones that remain as the fallback.
    The glass holds what has reached the cup: the water as it was poured while no filter is used (brown
    or amber if that is how it read), clear once a filter is in use, and then as the retest read.
    A cup just poured is shown as poured for about two and a half seconds even when the filter is
    chosen at once, so the dirty cup is seen before the filter comes in.
    The dropper over the glass holds the latest pour as it read before filtering. If that pour was
    sent through a filter, a funnel swings in, catches the drop and lets a clear one through; water
    that read in range falls straight in.
  - `/pitch/` - the pitch. It opens on black and runs through five single-step slides (scroll, swipe or
    arrow keys; `End` jumps to the last one): title, problem, system overview, value, and close.
    The short deck introduces the demonstration; `/pitch/?full` retains the ten-slide technical deck
    and its four-step Measure / Interpret / Act / Compare walkthrough for questions.
    In a wide window an unbranded 3D glass stays on stage beside the slides. Untreated water is shown
    as poured; the savings slide shows an in-range cup without a filter.
    Advancing past the close opens a setup screen: enter a prototype testing location, explore a sample
    cup, or explore the simulated network. Prototype mode waits for a physical gateway and never falls
    back to sample readings. The setup screen's return link or `/pitch/` starts the pitch again.
  - `/network/` - a simulation, labelled as one: a pipe network with a dozen sensor nodes, seven scripted
    scenarios, the trace back to the pipe each most likely entered from, and an incident report that can
    be printed or saved as a PDF. See "Simulated network" below.
  - `/map/` - the 3D map dashboard: every node on a map of Princeton and the US, with its latest test.
    Its source is `clarity-dashboard-2/`; `web/map/` is the committed build (see below).
  - Slides are in `web/pitch/slides.html`. The pitch is drawn over the demo page, so both are one document.
  - The labeled demo uses built-in sample data. A prototype selection stays offline until a physical
    gateway is reachable; `?api=http://<pi>:8000` points it at another gateway.

## How the parts fit together
One gateway, and everything else reads from it:

```
tank -> radio -> gateway (gateway/gateway.py, port 8000)
                   |- /demo/ /pitch/ /network/      web/            plain files, no build
                   |- /map/                         web/map/        built from clarity-dashboard-2/
                   |- /api/..., /ws                 the same data for all of them
                   '- /ws  ->  photon-alerts/       texts people when a pour fails (optional, separate process)
```

- **Start it:** `cd gateway && python gateway.py` (or `MOCK=1 python gateway.py` with no hardware). That
  serves all four pages. Nothing else needs to run for the demo.
- **The map dashboard** (`clarity-dashboard-2/`, Vite + MapLibre + deck.gl) is built into `web/map/`, which
  is committed so the Pi needs no Node. After changing it: `cd clarity-dashboard-2 && npm ci && npm run build`.
  For live editing, `npm run dev` proxies `/api` and `/ws` to the gateway. With no gateway it shows
  "Gateway offline"; `?mock=1` shows its own demo data, labelled, and the main page's Map link uses
  that when the main page is on sample data too.
  The map's 18 MB of data is fetched once: it goes out compressed (about 3 MB), the browser keeps it
  for a day and the built bundle for good, and on a wide screen the main page fetches it quietly
  in the background, so the map opens at once. The same rules are in `web/vercel.json` for the hosted copy.
  What is on the map speaks in three voices, and the legend and the Layers menu use the same names for
  them. White is ours, a real reading. Grey is simulated, and says so. Blue is context: the water system
  (the illustrative route, the tower, the plants) and other people's published readings (USGS streams as
  open rings). TDS is blue under the EPA line and rose over it everywhere, tanks and US samples alike.
  The map opens on a start screen: a globe (`src/intro.js`) drawn from the same world outline the map uses
  zoomed out, one line about the country's water worked out from the public samples the map carries, and
  two ways in. "Start the Princeton demo" slows the globe to a stop with Princeton in front and dives in;
  on the way down the globe takes on the map's colours and flattens into the map's projection at the map's
  scale, so the real map takes over underneath with no cut and carries on down to the tank. "Look across
  the country" gives way to the US view. Any key takes the demo. The rest of the page still works while it
  waits (a search or the USA button takes over), and `?nointro` leaves it out. The home view is `HOME` in
  `src/main.js`. `node test_intro.mjs` checks the slow-down and the land it draws.
  While the start screen waits it covers the panel too and the toolbar steps back, all but the search.
  The Water source tab has a section "On the public record": what EPA's own records say about the system
  that serves Princeton (who it serves, violations by quarter and on record, lead at the tap, its wells and
  intakes, PFAS from the UCMR 5 survey), each with its source, and the day it was fetched. It is collected
  ahead of time by `python3 scripts/public_record.py` and stored in `public/data/public_record.json`, not
  looked up by the page. It never says the water is safe or unsafe, and it says a detection is not a violation.
  The basemap, 2D, orbit and tour controls are in the "View and layers" menu, so the bar is the logo, the
  search and one button.
  Away from Princeton there is no Clarity site, so the card at the bottom left says what is publicly known
  about the water there instead: how many Water Quality Portal sites in view (or within 25 km, when zoomed
  in) were sampled for dissolved solids since 2024, their median, the share over the EPA's 500 ppm
  guideline, and how long half of them have gone without a new sample. It is worked out in the page from
  data the map already ships, with no model. Those samples are rivers, lakes and wells, not tap water,
  and the card says so; the portal's estuary, ocean, sewage, mine and stormwater rows are left out, and the
  EPA's 500 ppm drinking-water guideline is described as shown for scale.
- **The Photon agent** (`photon-alerts/`, its own README) watches the gateway's `/ws` and texts
  subscribers. It needs Photon keys and a Google key; `DRY_RUN=1 npm run dev` prints the texts
  instead of sending them. It is not needed for the pages.
- **One Google key** (`GOOGLE_API_KEY`) serves the gateway's filter decisions, the investigator's
  agents and the Photon agent. All three default to a Gemini Flash model; `GEMINI_MODEL` sets it.
- **Offline tests:** use the named commands under "Local measurement integrity and simulation checks"
  below, plus `cd photon-alerts && npm test`. `gateway/test_cloud.py` is separate and changes the configured
  cloud database; do not include it in a local test sweep.

Wording is the same everywhere: a `SAFE` verdict is shown as "In range", simulated nodes and demo
data are labelled, and nothing calls water safe.

## The pages on the web
`web/` is plain static files, so it can be hosted anywhere. It is deployed from that folder to
Vercel's free tier at https://wateramong.us (also https://wateramongus.vercel.app; `cd web && vercel deploy --prod`;
`web/vercel.json` only makes addresses end in a slash). With no gateway behind it, the pages there
run on the built-in sample data and say "Demo data". The live readings stay on the base station.

## Data format
The receiver prints one JSON object per line at 115200 baud:
```
{"node":"tank-01","test":17,"phase":"before","ph":7.21,"tds":482,"clarity":0.83,"verdict":"HIGH_TDS","filter":"BRITA","ask":0,"rssi":-61}
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
| filter | the tank's own rule: `NONE` or `BRITA`. The protocol still carries `ZEROWATER`; with one filter on the rig the gateway records it as `BRITA` (`FILTERS=ZEROWATER,BRITA` brings the second filter back) |
| ask | `1`: the tank is unsure (a reading near a limit, two problems at once, or a sensor that looks wrong) and waits up to 8 s for the gateway's answer. `0`: a clear call, already acted on by the tank's rule. Left out by older firmware, which always waits. |
| rssi | radio signal strength, dBm |

The gateway adds `id`, `ts` (UTC ISO), `lat`, `lon`, `sim`, `anomaly` (0-1), and later
`ai_filter`, `explanation` and `source` (who chose the filter: `gemini`, `claude` or `local_rule`).
For a clear call (`ask` 0) the source is always `local_rule`, nothing is sent back to the tank, and
the model is asked only to explain; its words are kept only if it would have chosen the same filter.

Lines are checked before they are stored: the node must be one the gateway knows (`ALLOW_UNKNOWN_NODES=1`
lifts that), and the phase, verdict and number ranges must be valid. Anything else is dropped with a
logged reason.

Gateway to tank (the model's decision, sent back over radio when the tank asked): `{"cmd":"filter","test":17,"filter":"BRITA"}`.
The Uno sketch also accepts `RETEST` ("check the probes and test again"); the gateway does not send it yet.

**pH on the current Uno sketch is not measured.** `PH_FROM_TDS 1` in `taptest_uno.ino` estimates pH from
dissolved solids (7.0 at 150 ppm rising to 8.3 at 800 ppm), because the probe drifts without buffer
solutions to calibrate it. Set it to `0` once the probe is calibrated. Until then the pH on the pages
is an estimate and carries no information that dissolved solids do not.
The pages say so: the cup's note reads "Acidity, estimated", the map's card "pH, estimated", and the pitch's first step
"pH, estimated for now". They stop saying it when the gateway is run with `PH_ESTIMATED=0`, which is only
true once the probe is calibrated and the sketch is flashed with `PH_FROM_TDS 0`.

## Gateway API (port 8000)
- `WS /ws` - live messages:
  - `{"type":"reading", ...all fields above}`
  - `{"type":"decision","id":..,"node":..,"test":..,"ai_filter":..,"explanation":..,"source":"gemini"|"claude"|"local_rule"}`
  - `{"type":"filters","filters":[...same as GET /api/filters]}` - after every tip and every retest
  - `{"type":"report","node":..,"test":..,"summary":"..","findings":[..],"actions":[..],"filter":..,"source":"rules"|"deepagents","model":..,`
    `"kind":"local_event","kind_words":"..","severity":0|1|2,"severity_words":"..","checks":{...GET /api/analysis},"sections":[{"agent","title","text"}],"notice":".."}`
- `GET /api/nodes` - every node, location, latest reading
- `GET /api/readings?node=tank-01&limit=200` - history, newest first
- `GET /api/tests/{node}/{test}` - the before/after pair for the before/after card
- `GET /api/filters` - `[{"filter":"BRITA","liters":3.2,"last_after_tds":212,"status":"OK"|"REPLACE_SOON"|"REPLACE", ...}]`, one entry per fitted filter (see below)
- `POST /api/filters/brita/replace` - a new filter went in: start its count over (a control, see below)
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
The rig has one filter, a Brita Elite, and the servo always tips the cup there: dissolved solids over
300 ppm or transparency under 0.70 send the cup to it, and a pour in range skips it. A carbon filter
is not built to take dissolved solids out, and nothing here says it does; the retest shows what it changed.
Every time the cup tips, the gateway counts about 0.1 L through the filter (`LITERS_PER_TIP`).
- **Brita Elite**: rated for about 450 L. `REPLACE_SOON` at 90%, `REPLACE` at 100%.
- **ZeroWater** (not fitted; `FILTERS=ZEROWATER,BRITA` brings it back): `REPLACE` once an `after` test of
  ZeroWater-filtered water reads 6 ppm or more (ZeroWater's own "006" rule), until the replace endpoint is called.

## Which model
The filter decision and the investigator's agents call Google's Gemini API (`google-genai` and
`langchain-google-genai`) when `.env` has `GOOGLE_API_KEY` or `GEMINI_API_KEY`, and Claude (Opus
5.5) when it has only `ANTHROPIC_API_KEY`. `AI_PROVIDER=google|anthropic` chooses when both are set.

- **The filter decision** uses `GEMINI_MODEL` if the key can use it (a Gemma model works: one small
  call per pour), else the first of `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`,
  `gemini-3.5-flash-lite` that the key has.
- **The agents** use `GEMINI_AGENT_MODEL` if set; otherwise the same model, unless that is a Gemma
  model, in which case they use a Flash model. Gemma's limit on the Gemini API (16,000 input tokens
  a minute on a tier 1 key) is far below what one report needs, and the first live run failed on it.
- `/health` reports `ai_name`, `ai_model`, `agent_name` and `agent_model`, and the pages name them.
- If a call fails or runs out of quota, the tank's own rule decides and the rule-written report stands.

What a live run showed (Gemma 4 for decisions, Gemini 3.8 Flash for agents, 14 November 2026):
a report took 21 seconds with four specialists, and all 40 of its figures traced to a tool result.
Getting there needed three fixes, each kept in the code with its reason: a cap on how often one
agent may call the same tool (one searched the guidance ten times until a call timed out), no
thinking budget for the specialists (they spent thousands of thinking tokens on three sentences),
and telling each specialist to keep to its own tools (one wandered into the file tools). The
Claude path has not been run: there was no Anthropic key.

The filter decision on Gemma is unreliable: in JSON mode about one first answer in three ran away
repeating a word until it hit the token cap. The gateway caps the answer, asks once more, and
otherwise lets the tank's rule decide; with that, 8 of 12 test decisions came back in time. On
`gemini-3.8-flash` (thinking off for this call) 9 of 9 did, in about 2.4 seconds each. Set
`GEMINI_MODEL=gemini-3.8-flash` in `.env` to use it for decisions too.

## Layered detection (`analysis.py`)
A new sensor has almost no labelled data, so detection is statistics, in three layers, worked out
by plain code before any model is asked:

1. **Sensor checks.** Is the sensor believable? Out of range, stuck on one value, reading zero on
   unfiltered water, or trending slowly one way. A sensor fault is not a water event.
2. **The node's own baseline.** Robust z-scores (median and MAD) against the node's own earlier
   pours; EWMA and CUSUM control charts for small shifts that persist; one multivariate
   (Mahalanobis) distance across the readings.
3. **Peer comparison.** Did the neighbours move the same way? Regional if at least two nearby
   nodes, and at least half of them, did. Otherwise local.

Then one verdict (`normal`, `sensor_fault`, `local_event`, `regional_shift`, `persistent_shift`)
with a severity (0 no action, 1 worth a second look, 2 act on it) and the evidence as sentences
that carry their numbers. `GET /api/analysis` returns all of it.

While the tank only estimates pH (see above), pH is left out of all three layers: it is not checked as a
sensor (the estimate is exactly 7.0 for any water under 150 ppm, which would read as a stuck sensor), it
cannot be the reading a verdict rests on, and it adds nothing to the combined distance, where it would
count dissolved solids twice. `PH_ESTIMATED=0` puts it back.

The layering follows the plan the project started from, which points to EPA's CANARY event detection
software as the reference for this kind of approach. Against that plan, what is not here: baselines
adjusted for time of day or temperature, a spike filter as such (a one-off reading is reported as "the
only unusual pour in a row"), and the machine-learning stretch (an isolation forest or an autoencoder).

What it does not do: there is no pipe network or hydraulic model behind this, so nothing is traced
to a pipe segment; the neighbours are simulated nodes, and say so; there is no temperature sensor,
so baselines are not temperature-adjusted; and no machine-learning model is involved. The control
chart settings were chosen on simulated quiet data (about 3 false alarms per 1,000 pours).

`python test_analysis.py` checks it (20 checks, no hardware or key needed).

## Investigator (deepagents)
Every `after` test gets a report at once, written from the checks above by fixed rules
(`"source":"rules"`), so the page never waits on a model and still has a report with no key or
no internet.

When a model key is set (see "Which model" below), a LangChain deep agent then writes a fuller
one (`"source":"deepagents"`), which takes the first one's place on the page. The lead agent
hands the case to five specialists at once through deepagents' `task` tool, each with only its
own tools:

| Specialist | Question | Tools |
|---|---|---|
| `sensor-health` | Can the sensor be believed? | `get_sensor_checks` |
| `analyst` | Is this unusual for this site? | `get_baseline`, `get_site_history`, `query_readings` (one read-only SQL `SELECT`) |
| `network` | Local or regional? What is published nearby? | `get_peer_comparison`, `get_nearby_nodes`, `get_reference_data` |
| `maintenance` | Filter life and upkeep | `get_filter_life`, `search_guidance` (search over EPA and AWWA documents, below) |
| `comms` | A short notice for the people who use this water | `get_notice_templates` |

Three things happen around the specialists:

- **Triage.** `analysis.plan` decides from the checks which specialists a run needs, and why: two
  for an ordinary filtered pour, four for an unusual one, the sensor specialist first when a sensor
  check fails. The lead is handed that plan and may add to it only with a stated reason.
- **Watching.** Every hand-off, tool call and answer is sent over `/ws` as it happens
  (`{"type":"agent","event":"plan"|"asked"|"tool"|"answered"|"check"|"done"|"failed", ...}`), and the
  page shows the agents working until the report arrives.
- **Checking.** `analysis.ground` compares every figure in what the agents wrote with the case and
  with everything a tool returned during the run. A finding or action with a figure that cannot be
  traced is dropped, and the report records how many figures were checked.

The agents explain and decide what to do next; they do not compute. Every number comes from a
tool, and the verdict and severity come from `analysis.py`, not from a model. The notice is
filled in from fixed templates, always ends with what Clarity cannot detect, is discarded for
the fixed version if a model's draft drops that sentence, and is only shown: nothing sends it.

### The guidance it searches
`python fetch_guidance.py` (needs internet once, and `pip install pypdf`) downloads 14 documents
from epa.gov, splits them into passages and writes `gateway/guidance_index.json`:

- EPA's own guidance: Online Water Quality Monitoring in Distribution Systems (2018), Exploratory
  Analysis of Time-Series Data (2016), Guidance for Responding to Drinking Water Contamination
  Incidents (2018) and its planning primer, Developing Risk Communication Plans (2013), the
  distribution-system flushing fact sheet (2022), and the secondary standards page.
- Five distribution-system issue papers AWWA prepared for EPA (2002): New or Repaired Water
  Mains, Effects of Water Age, Permeation and Leaching, Finished Water Storage Facilities,
  Nitrification. And two that American Water prepared for EPA: Deteriorating Buried
  Infrastructure, and Intrusion of Contaminants from Pressure Transients.

`search_guidance` ranks passages with BM25 (keyword ranking; no embeddings, no model call, works
offline) and returns up to three, each with its document, who prepared it, page and URL, so the
agent can cite it. The index holds the documents' text, so it is git-ignored and built on each
machine. Without it the search falls back to the team's short notes in `guidance.json`; the filter
makers' replacement rules there are always searched, because no EPA or AWWA document covers them.
Not included: AWWA's own standards and manuals (C651, the M-series), which are sold, not
published. These documents were written for water utilities, not household cups, and the agent
is told to say so. `python test_guidance.py` checks the search (13 checks).

`INVESTIGATOR=0` turns the agents off, `INVESTIGATOR_EFFORT=medium` makes them dig deeper, and
`INVESTIGATOR_SUBAGENT_MODEL` gives the specialists a different model from the lead.

`python test_swarm.py` drives the lead and all five specialists with scripted stand-in models
(no key needed): it shows the delegation, the tool wiring, the read-only SQL guard and the
fallback to the rule-written report, on both the Gemini and the Claude path. It does not show what
either model would write; that needs a key.

## Simulated network: tracing a change to a pipe
Clarity has one real node, so this part is simulation and says so everywhere it appears. It shows
what a utility could do with many nodes: when several alert, work out which pipe the change most
likely entered from.

- `build_network.py` (run once, needs WNTR; not needed on the Pi) loads WNTR's Net3 example network
  (EPANET example 3: 97 nodes, 117 pipes), solves its hydraulics, freezes one hour, picks 12 sensor
  nodes, gives every pipe synthetic material, age and break history, and injects four events. It
  writes `network.json`, which is committed.
- `localize.py` (standard library only) traces upstream from every alerting sensor along the flow,
  keeps the pipes upstream of all of them, scores each by how well its predicted gaps between
  arrivals match the observed ones and by quiet sensors it should have reached, and weights it by a
  hand-set risk score from the pipe's attributes. The result is a ranked list with each pipe's share
  of the weight and the reasons in sentences.
- `incident.py` writes the report around it by fixed rules: summary and severity, timeline, ranked
  segments, what to do next (each step with a passage from the EPA and AWWA documents, cited by
  document and page), the junctions downstream, a draft notice and the caveats.
  `python incident.py` also writes `web/network/data.json`, so `/network/` works with no gateway.
- `GET /api/network` returns the same thing from the gateway.
- With a model key, the page offers "Ask the investigator's agents": a second deepagents team (a lead with
  `topology`, `maintenance` and `comms` specialists) reads the trace through tools, searches the
  guidance and writes its own account (`POST /api/network/investigate?scenario=..`, a control). The
  agents are never shown where the simulation put the change.

How well it does. Run for a change entering at every pipe in turn: 30 of the 117 pipes reach no
sensor within six hours, so a change there goes unseen; of the rest, when two or more sensors alert
(71 pipes) the true pipe is ranked first for 32 and in the top three for 56, and when only one
alerts (16 pipes) it is first for 4. The page says this too. On its own four hand-picked events: the true pipe is ranked 1st, 1st and 2nd in the three
where three or more sensors alert, and 7th of 28 in the one where a single sensor alerts, which the
report says is too little to single out a pipe. `python test_localize.py` (53 checks) also runs a
change entering at every pipe in turn and prints how often the true pipe is found;
`python test_incident.py` (15 checks) covers the reports.

What it is not: there is no real pipe network, no real event and no trained model. Flow is frozen
at one hour; the pipe attributes and the risk score are made up; "downstream" counts junctions and
simulated demand, not customers.

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
- In the cloud: `readings` is a TimescaleDB hypertable; `readings_5min`, `readings_hourly` and
  `readings_daily` are continuous aggregates (per node, per 5 minutes, hour and day); old chunks are
  compressed after 7 days; and `nodes` and `reports` are ordinary tables you can join to. Every row says
  whether it is measured, simulated or from the mock. `anomaly_scores` is a view over the reports: one row
  per pour, reading and method (robust z, EWMA, CUSUM, Mahalanobis), so the detection's scores can be
  queried in SQL.
- When the cloud copy is on and connected, the cup page has a section "In the cloud database": the last
  day by the hour, read back from the hourly aggregate (`GET /api/cloud/rollup?bucket=hour`; `bucket` can
  also be `5min` or `day`).
- Old raw rows are dropped after 365 days (a retention policy); the hourly and daily rollups are kept, so
  the history stays.
- Rows from the mock tank are kept apart from measurements in every rollup, so a base station that measures
  is never shown the mock's readings, and the cup page says when what it shows is the mock's.
- Readings sent late (the first sync of what the Pi already held, or a backlog after an outage) are brought
  into the rollups at once, not at the next scheduled refresh.
- The simulated pipe network and the incidents traced on it are there too, every row marked simulated:
  `network_nodes`, `pipe_segments` and `incidents`, with PostGIS geometry where the extension is available
  (the network's own coordinates, not places on Earth). `downstream_of(network, pipe, minutes)` walks the
  flow in SQL and gives the same junctions as the tracer for every pipe. `python cloud.py check` loads them.
- `people` is a separate schema (premises, contacts, notifications) that nothing writes to yet: the gateway
  stores no personal data, and the Photon agent keeps its own list of who has joined. `clarity_reader` is a
  role that can read everything except `people` and can write nothing; grant it to anything that should
  only read.
- `python test_cloud.py` checks all of this against the real database (it needs `TIGER_DATABASE_URL`, and
  skips without it).

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
4. `python cloud.py rollup` prints the last hours from the continuous aggregate (`python cloud.py rollup
   tank-01 72 hour` for three days by the hour). `GET /api/cloud` shows
   rows sent and waiting, and the demo page says the same under Network.

## Run the gateway
```
cp .env.example .env                  # then put a Google (Gemini) or Anthropic key in .env (never commit it)
cd gateway
python3 -m venv .venv && . .venv/bin/activate   # Python 3.11+
pip install -r requirements.txt
MOCK=1 python gateway.py              # no hardware: fake tank + 12 simulated nodes
python gateway.py                     # real receiver, found automatically
MOCK=1 MOCK_SCENARIO=replay python gateway.py   # a quiet tank: play back the pours it sent earlier
```
A run against the real receiver keeps every line it sends in `gateway/logs/tank.jsonl` (not in git;
`RECORD=0` turns that off). `MOCK_SCENARIO=replay` plays that file back as new pours, with the tank's own
values and waits cut to the period (`MOCK_LOG=<file>` for a recording made elsewhere). With no recording,
`MOCK=1` runs estimated pours instead. The page says "Replayed pours" or "Simulated tank", never "Live".
`requirements.lock.txt` has the exact versions this was tested with (`pip install -r requirements.lock.txt`).

The gateway looks for the receiver's USB serial port itself, trying USB-serial adapters (the ESP32
receiver) before boards like the Uno. If more than one is plugged in it says which it picked; set
`SERIAL_PORT=/dev/...` to choose.
Without a key, the gateway uses the tank's local rule and writes each report from its own checks.
With one, the model picks filters (`"source":"gemini"` or `"claude"`) and the investigator's agents write the reports.
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


## Local measurement integrity and simulation checks

New firmware readings carry `ph_est`, a boot `session`, a `seq` and `sender_ms`. The gateway keeps
these in SQLite; an explicit per-reading pH flag overrides the deployment default. Estimates are
shown as estimates and excluded from independent sensor checks, baselines, control charts, joint
scores and pH alerts. A measured probe's history is not mixed with derived pH. Reports compare the
filter's targeted measurement, and an estimated retest cannot resolve an earlier measured pH warning.
Legacy packets without the flag use `PH_ESTIMATED` from the environment or local `.env`.

Duplicate radio packets and repeated UART readings of the same node/session/test/phase create no
new reading, tip, report, decision or broadcast. New readings are also keyed by node/session/seq.
Legacy packets use node/test/phase because they do not identify a boot; after resetting or wrapping
a test counter, start a new Feather session. Existing history is preserved by additive local migrations.
Before/after displays and accounting do not pair different boots that reuse a test number.

Commands carry an exact node, test and (for current firmware) session/sequence. The receiver learns
node MACs and unicasts; the Feather and Uno validate the target independently. All relevant sketches
and the gateway need updating together. See `firmware/PROTOCOL.md` for packet bounds and host tests.
Nothing here flashes hardware. New metadata is local-only for now: the cloud schema/mapping migration
is deferred, and these changes do not deploy or initialize a cloud database.

The four original network scenarios remain; three explicit stress cases add offline sensors, delayed
readings and conflicting alerts. An unavailable sensor is not evidence of quiet water. Poor timing fits
remain uncertain even if one pipe has most of the normalized ranking weight. Open `/network/` and
choose the labeled stress buttons, or use `#sensor-dropout`, `#delayed-sensor`, `#conflicting-alerts`.

The backend mock is reproducible with `MOCK_SEED` (default 26) and `MOCK_SCENARIO`:
`cycle`, `duplicate`, `sensor-fault`, `drift`, `regional`, or `close-call`. Default background simulated
sensor faults are off (`SIM_FAULT_RATE=0`); explicit stress scenarios do not weaken detection rules.
`MOCK_PERIOD` controls pace. Static cup data also uses a reproducible seed (`/demo/?demo&seed=26`).
All of these are generated examples, not field-performance evidence.

Run local checks without keys, hardware or cloud writes:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 gateway/test_analysis.py
PYTHONDONTWRITEBYTECODE=1 gateway/.venv/bin/python gateway/test_ingest.py
PYTHONDONTWRITEBYTECODE=1 python3 gateway/test_simulation.py
PYTHONDONTWRITEBYTECODE=1 python3 gateway/test_localize.py
PYTHONDONTWRITEBYTECODE=1 python3 gateway/test_incident.py
PYTHONDONTWRITEBYTECODE=1 python3 gateway/test_placement.py
node --test web/test_sample.cjs
python3 gateway/benchmark_simulations.py --json
```

`test_ingest.py` explicitly disables saved cloud/model credentials and uses a disposable database.
Do not include `test_cloud.py` in an offline run: that separate script initializes the configured
cloud schema. To rehearse a gateway scenario, use a temporary `DB_PATH` and explicitly blank
`TIGER_DATABASE_URL`, `DATABASE_URL`, `GOOGLE_API_KEY`, `GEMINI_API_KEY` and `ANTHROPIC_API_KEY`
before starting it; leave `INVESTIGATOR=0`. Merely setting `MOCK=1` does not disable cloud sync.


### Map simulation workspace and setup

The map's **Simulations** button overlays the modeled Net3 network on the Princeton demo map:
`/map/?mock=1&simulation=1&nointro`. The projection preserves all 97 nodes and 117 pipe connections,
but their geographic positions are illustrative, not actual Princeton pipe routes or installed sensors.
A schematic remains available. Replay runs in 24 seconds with pause/resume and a timeline; rankings
are withheld until the observation window finishes, including minute 385 in the late-report case.
Bundled examples render immediately while optional data refreshes happen in the background.
Incident replay offers the seven labeled scenarios; sensor
placement compares budgets of 4/8/12/16/20 against the existing 12-site layout. The recommendation
uses directed flow/travel times and a deterministic greedy objective: first coverage, a second
observation, then earlier alerts. All 117 modeled pipe-source events remain in the denominator.
It is a model-based heuristic with equal assumed costs, not actual Princeton installation sites
or a guarantee of optimality. More coverage can include distant events and raise the observed-only
median; the comparison also reports mean delay with unseen events counted at six hours.
`GET /api/network/placement?budget=12` is read-only, with a prepared static fixture for offline use.

The normal map background starts healthy. Outages and probe faults are deliberate stress cases,
not frequent background animations. Cloudy/salty cup examples represent water readings rather
than a broken sensor. The globe now has a responsive composition with 23° axial tilt, takes the nearest orientation
in at most 3.2 seconds, then approaches over 6.2 seconds. The close arrival frames the Princeton Ridge
water tower and town at zoom 14.2. It returns north-up before joining the map; reduced motion and
skip controls are retained.

After the pitch, a setup screen offers prototype testing at an entered location or a labeled demo.
Open it directly at `/demo/?setup=1`. Suggestions use bundled place data; current location is
requested only when the person presses its button. Setup is saved only in that browser. It does
not update device coordinates or the cloud database. In prototype mode a missing or simulated
gateway shows a disconnected state with no sample readings. Demo mode explicitly chooses sample
data; it can open the cup or the map simulation workspace.


Mock gateways now default to `taptest-mock.db`; physical gateways retain `taptest.db`. An explicit
`DB_PATH` still wins. Existing files are never deleted or relabeled. Older databases may already
contain unlabelled mock history: keep a separate local file for hardware rehearsals when the
origin of that history is unknown. The prototype connection guard checks the active gateway; it
cannot infer the origin of old rows that never recorded it.

The local demo's 180–220 ppm ambient TDS values are illustrative assumptions, not values reported
by the utility. Public Princeton/NJ American Water sources establish supply context, while historical
stream samples remain a separate published-data layer. Normal background sensors and lightly used
cartridges remain healthy; scripted cloudy/salty cup examples deliberately exercise decisions/retests.

For startup, `scripts/compact_assets.py` in `clarity-dashboard-2/` generates a 62 KB named-building
point index and a compact globe outline; full source geometry is retained. Infrastructure loads
independently, while decorative trees wait until arrival and use a stable one-third sample.
