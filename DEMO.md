# Running the demo

Keep the five-slide pitch brief so there is time to show the prototype or a demo. This is what to have
ready and what a judge is likely to ask, with the answers the build supports. It came out of three
independent reviews of the site (a judge, a water engineer and a design lead) the night before submission.

## Have ready before you start

- **Two cups.** One that reads near 300 ppm, so the page says the model made the call: the tank only
  sends a pour to the model when it is unsure (within 45 ppm of 300, within 0.08 of 0.70 transparency, two
  problems at once, or a sensor that looks wrong). Every other pour is settled by the tank's own rule, and
  the page says so. And one cup already filtered, to pour back at once: the retest is the payoff, and the
  report only appears after it.
- **For the physical prototype:** the gateway running with the actual receiver (`cd gateway && python
  gateway.py`, without `MOCK=1`) and the page showing "Live". Prototype mode requires a verified physical
  gateway; an unavailable or mock gateway stays disconnected rather than substituting sample readings.
  If the pages are hosted separately, open `/pitch/?api=http://<pi>:8000`; the setup flow keeps that address.
- **A phone already joined to the Photon line** (text JOIN to it beforehand; the line cannot send the first
  message). Then the alert arrives on stage.
- **If the cloud copy is already configured:** with `TIGER_DATABASE_URL` set, the foot of the cup page says
  how many readings are in the cloud database. Scroll to it or say it. Local rehearsal does not require
  enabling the cloud copy or changing its schema.
- **The map in a second tab**, waiting on its start screen. Enter or Space starts the Princeton demo; Tab navigates the two choices.
- **`/pitch/` in a wide window.** Arrow keys or scroll advance one slide at a time: the default deck has
  five single-step slides. `/pitch/?full` keeps the full technical deck for questions, including the
  four-step cup loop and the hardware, AI, filter-life, sources and open-questions slides.
- **Know the setup screen.** Advancing beyond the final slide asks where to begin. A saved choice is
  prefilled, but the screen is shown again after each pitch. `/demo/?setup=1` opens it directly for rehearsal.

## If the tank's data does not work

The rig has one filter, the Brita. On the retest expect salt water to read about what it did (a carbon
filter leaves dissolved solids in: within a few percent, still high) and tea or cloudy water to come back
clearer. Say that out loud: the retest is there to show what the filter changed, including "not much".

Three ways to carry on, the most real first. The page labels each for what it is.

1. **The tank's own pours, replayed.** Any run against the real receiver keeps what it sends in
   `gateway/logs/tank.jsonl`. If the tank goes quiet: `cd gateway && MOCK=1 MOCK_SCENARIO=replay python
   gateway.py`, then open `http://<gateway>:8000/demo/?mode=live`. The page says "Replayed pours". The
   values are the tank's own; waits longer than 25 seconds are cut. A recording made on another machine:
   `MOCK_LOG=/path/to/tank.jsonl`.
2. **Estimated pours.** No recording yet: `cd gateway && MOCK=1 python gateway.py`, same address. The page
   says "Simulated tank". A cup every 25 seconds, the retest 15 seconds later: tap water in range (about
   140 ppm), salt water (about 780 ppm, about 760 after the Brita) and tea (transparency about 0.42, about
   0.9 after). These are our estimates of the rig, not measurements.
3. **No gateway at all.** On the hosted site, the setup screen's "Follow a cup" (or `/demo/?demo`) runs the
   built-in sample cycle, labelled "Demo data".

"Test the prototype" refuses a simulated gateway on purpose, which is why 1 and 2 use `?mode=live`.

## The two minutes

The short deck introduces the demonstration; it does not walk through every technical detail.
Each forward press advances a whole slide, including the third slide.

1. **Title.** Water monitoring that helps utilities decide where to investigate.
2. **The problem.** Water changes between samples. The useful context is when a change began, which
   sites moved, and where to investigate.
3. **From one cup to a wider view.** A sensing node, a radio gateway, and an investigation view that
   turns readings into the next place to look. The four-step filter walkthrough is in `?full`.
4. **Where measurement helps.** Watch more places through modeled coverage, separate sensor faults
   from unusual water readings, and avoid unnecessary filtering or follow-up work.
5. **Close.** One prototype, one simulated network. Advance once more to choose the demonstration.

## Choose the demonstration

The setup screen separates a real test from an example:

- **Test the prototype.** Complete “I’m testing the prototype in…” with a city or place. Autocomplete
  searches the bundled Princeton-area places; a typed place is also accepted. “Use my current location”
  requests browser permission only when clicked. Open the test, pour, and compare the retest. With no
  physical gateway connected, the page explains that it is offline and shows no sample measurements.
- **Explore a demo → Follow a cup.** Starts the clearly labelled sample-data cycle in Princeton. Use
  this for a reliable walkthrough without hardware; it does not display a live gateway’s readings.
- **Explore a demo → Explore the network.** Opens the map’s simulation view, with the prepared events
  and sensor-placement budgets. Compare a few sensor counts and inspect an event; the graph and
  locations are a modeled example, not Princeton’s actual pipe network.

The choice and location stay in this browser. They do not assign a sensor, change hardware coordinates,
or write to the cloud. The selected flow opens fresh so prototype and sample readings are kept apart.
Use the Clarity wordmark to return to the pitch; a supplied `api` address is preserved.

While a physical filter drips, switch to the map in the second tab. The normal map’s start screen still
opens the Princeton view; “Look across the country” and search show publicly available context elsewhere.
The full `/pitch/?full` deck is for technical questions after the short presentation and ends at the same
setup chooser.

## What a judge will ask

- **Is the pH real?** Not yet. The current sketch estimates it from dissolved solids because the probe is
  not calibrated, and every page says "estimated". Calibrating takes two buffer solutions and a reflash
  with `PH_FROM_TDS 0`; then run the gateway with `PH_ESTIMATED=0`.
- **What does the AI add over an if-statement?** It decides the close calls, explains each one, and a team
  of agents writes the report. Verdicts and numbers stay in code: every figure in a report is traced back
  to what a tool returned, and anything that cannot be traced is dropped. A rule keeps the cup moving with
  no internet.
- **Who is it for?** The short pitch leads with utilities: monitoring that helps decide where to
  investigate. The cup is a bench prototype, and the network view is simulated; neither demonstrates
  an installed smart-meter integration.
- **What is the measured impact?** There is no figure the hardware can back. The closest is the page's own
  tally of pours that needed no filter.
- **What does "affordable" cost?** The repo states no price. If you know what the parts cost, say that;
  otherwise say "hobby boards" and stop there.
- **Is the map's national data drinking water?** No. It is untreated rivers, lakes and wells from the Water
  Quality Portal. The 500 ppm line is EPA's drinking-water guideline, shown for scale.
- **Is the pipe tracing real?** No, and the page says so: it is a simulation on WNTR's Net3 example
  network. Run for every pipe, the true pipe is ranked first for 32 of the 71 where two or more sensors
  alert, and 30 of 117 pipes reach no sensor at all.
- **What does the public record say about Princeton's water?** The map's Water source tab has it, from
  EPA: no violation in the last twelve reported quarters, lead at 0.002 mg/L against an action level of
  0.015, and PFAS detected below New Jersey's limits. Those are records for the whole system, not a test
  of any tap. Never say the water is safe.

## Not checked by the reviews

The real tank end to end, the Pi's keys, the cloud copy and the Photon line running. Run the whole thing
once on the hardware before you present.
