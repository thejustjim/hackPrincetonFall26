# Running the demo

Two minutes of pitch, then the live demo. This is what to have ready and what a judge is likely to ask,
with the answers the build supports. It came out of three independent reviews of the site (a judge, a
water engineer and a design lead) the night before submission.

## Have ready before you start

- **Two cups.** One that reads near 300 ppm, so the page says the model chose the filter: the tank only
  sends a pour to the model when it is unsure (within 45 ppm of 300, within 0.08 of 0.70 transparency, two
  problems at once, or a sensor that looks wrong). Every other pour is settled by the tank's own rule, and
  the page says so. And one cup already filtered, to pour back at once: the retest is the payoff, and the
  report only appears after it.
- **The gateway running with its keys** (`cd gateway && python gateway.py`) and the page showing "Live".
- **A phone already joined to the Photon line** (text JOIN to it beforehand; the line cannot send the first
  message). Then the alert arrives on stage.
- **The cloud copy on.** With `TIGER_DATABASE_URL` set, the foot of the cup page says how many readings are
  in the cloud database. That line is the only place Tiger Cloud shows, so scroll to it or say it.
- **The map in a second tab**, waiting on its start screen. Any key starts the Princeton demo.
- **`/pitch/` in a wide window.** Arrow keys or scroll; `/pitch/?full` has five more slides for questions.

## The two minutes

1. **Title.** One sentence on what it is.
2. **The problem.** The stream's dissolved solids were last sampled in 2023; 17 sample days since 2000.
   Then the turn: that is the stream, and at the tap the utility tests its system, not your cup.
3. **One cup, one loop.** Four presses: measure, interpret, act (the filter snaps in and the water
   clears), compare.
4. **What it saves.** A cup that reads in range skips the filter.
5. **Close.** Gemini decides the close calls, LangChain deep agents write the report, Tiger Cloud keeps
   the history, Photon texts the alert. Then scroll on into the live cup and pour.

While the filter drips, switch to the map and start the Princeton demo. "Look across the country" and the
search show what is publicly known anywhere else.

## What a judge will ask

- **Is the pH real?** Not yet. The current sketch estimates it from dissolved solids because the probe is
  not calibrated, and every page says "estimated". Calibrating takes two buffer solutions and a reflash
  with `PH_FROM_TDS 0`; then run the gateway with `PH_ESTIMATED=0`.
- **What does the AI add over an if-statement?** It decides the close calls, explains each one, and a team
  of agents writes the report. Verdicts and numbers stay in code: every figure in a report is traced back
  to what a tool returned, and anything that cannot be traced is dropped. A rule keeps the cup moving with
  no internet.
- **Who is it for?** The team has not settled this (towns and utilities, or households). Decide which one
  you will say before you present.
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
