"""Layered detection: what the numbers say, worked out before any model is asked.

There is almost no labelled data for a new sensor, so this is statistics, in three layers:

  1. Sensor checks      Is the sensor believable? Out of range, stuck on one value, reading
                        zero, or trending slowly one way. A sensor fault is not a water event.
  2. This node's own    Robust z-scores (median and MAD) against the node's own history, EWMA
     baseline           and CUSUM control charts for small shifts that persist, and one
                        multivariate distance (Mahalanobis) across all three readings.
  3. Peer comparison    Did the neighbours move the same way? Then it is regional (a change of
                        source, the weather). Only this node? Then it is local.

Then one verdict: normal, sensor fault, local event, regional shift or persistent shift, with
a severity and the evidence for it as plain sentences that carry their numbers.

The investigator's agents read these results through tools. They explain and decide what to
do next; they do not compute. Everything here is a pure function of lists of readings (no
database, no network), so it can be tested alone: python test_analysis.py
"""
import math
import statistics

METRICS = ("ph", "tds", "clarity")
LABEL = {"ph": "pH", "tds": "dissolved solids", "clarity": "transparency"}
PHYSICAL = {"ph": (0, 14), "tds": (0, 5000), "clarity": (0, 1)}       # what each sensor can read
# Used until a node has enough history of its own: (typical value, spread) for water around Princeton
TYPICAL = {"ph": (7.5, 0.3), "tds": (180, 70), "clarity": (0.95, 0.04)}
FLOOR = {"ph": 0.1, "tds": 10, "clarity": 0.02}   # smallest spread worth believing (sensor noise)
MIN_HISTORY = 8                                   # readings before a node's own baseline is used
CLIP = 2.0                                        # the control charts count no single pour as more than this many spreads
RECENT = 10                                       # pours the control charts look across
STUCK_RUN = {"ph": 8, "tds": 5, "clarity": 8}     # identical readings in a row that mean "stuck"
Z_OUT = 3.0                                       # a reading this many spreads from the median is unusual
D_OUT = 3.4                                       # Mahalanobis distance: about the 99th percentile for three readings
KIND_WORDS = {"normal": "Nothing unusual", "sensor_fault": "The sensor needs checking",
              "local_event": "Unusual for this site", "regional_shift": "The neighbours moved too",
              "persistent_shift": "A slow shift"}
SEVERITY_WORDS = ["No action needed", "Worth a second look", "Act on it"]


def fmt(metric, v):
    return f"{v:.0f} ppm" if metric == "tds" else f"{v:.2f}" if metric == "clarity" else f"{v:.1f}"


# ---------------------------------------------------------------- layer 2: the node's own baseline
def baseline(values, metric):
    """Robust centre and spread of past readings: the median, and the median absolute deviation
    scaled to a standard deviation. Outliers barely move either, unlike a mean and variance."""
    vals = [v for v in values if v is not None]
    if len(vals) < MIN_HISTORY:
        med, sig = TYPICAL[metric]
        return {"median": med, "sigma": sig, "n": len(vals), "source": "typical"}
    med = statistics.median(vals)
    sig = max(1.4826 * statistics.median(abs(v - med) for v in vals), FLOOR[metric])
    return {"median": round(med, 3), "sigma": round(sig, 3), "n": len(vals), "source": "history"}


def control_charts(series, base, lam=0.3, limit=3.5, slack=0.75, alarm=5.0):
    """EWMA and CUSUM over a series (oldest first), in units of the baseline's spread.
    Each point is clipped at two spreads first, so one wild reading cannot trip either chart:
    that is the z-score's job. These two exist to catch small shifts that persist.
    The settings were chosen on simulated quiet data: about 3 false alarms per 1,000 pours,
    while a shift of two spreads lasting nine pours is caught about 5 times in 6."""
    ewma = up = down = 0.0
    for x in series:
        z = max(-CLIP, min(CLIP, (x - base["median"]) / base["sigma"]))
        ewma = lam * z + (1 - lam) * ewma
        up = max(0.0, up + z - slack)
        down = max(0.0, down - z - slack)
    ewma_limit = limit * math.sqrt(lam / (2 - lam))
    return {"ewma": round(ewma, 2), "ewma_limit": round(ewma_limit, 2), "ewma_signal": abs(ewma) > ewma_limit,
            "cusum": round(max(up, down), 2), "cusum_limit": alarm, "cusum_signal": max(up, down) > alarm,
            "direction": "up" if (ewma > 0 if abs(ewma) > 1e-9 else up >= down) else "down"}


def _inverse3(m):
    (a, b, c), (d, e, f), (g, h, i) = m
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-9:
        return None
    return [[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
            [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
            [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]]


def mahalanobis(z, past_z):
    """How far the three readings are from normal taken together, allowing for how they usually
    move with each other. `z` and each row of `past_z` are already in units of spread. The
    correlations are shrunk toward none, the more so the less history there is."""
    n = len(past_z)
    corr = [[1.0 if i == j else 0.0 for j in range(3)] for i in range(3)]
    if n >= MIN_HISTORY:
        cols = [[max(-4.0, min(4.0, row[k])) for row in past_z] for k in range(3)]
        means = [statistics.fmean(c) for c in cols]
        sds = [statistics.pstdev(c) for c in cols]
        keep = 1 - max(0.3, MIN_HISTORY / (n + MIN_HISTORY))
        for i in range(3):
            for j in range(i + 1, 3):
                if sds[i] > 1e-9 and sds[j] > 1e-9:
                    cov = statistics.fmean((cols[i][t] - means[i]) * (cols[j][t] - means[j]) for t in range(n))
                    corr[i][j] = corr[j][i] = keep * cov / (sds[i] * sds[j])
    inv = _inverse3(corr) or [[1.0 if i == j else 0.0 for j in range(3)] for i in range(3)]
    zc = [max(-12.0, min(12.0, v)) for v in z]
    d2 = sum(zc[i] * inv[i][j] * zc[j] for i in range(3) for j in range(3))
    return round(math.sqrt(max(0.0, d2)), 2)


# ---------------------------------------------------------------- layer 1: is the sensor believable?
def trend(values, sigma):
    """A slow one-way trend: the median of all pairwise slopes (Theil-Sen) over the last readings.
    Reported only when it adds up to two spreads or more and most pairs agree on its direction."""
    vals = values[-30:]
    if len(vals) < 12:
        return None
    slopes = [(vals[j] - vals[i]) / (j - i) for i in range(len(vals)) for j in range(i + 1, len(vals))]
    slope, rising = statistics.median(slopes), sum(s > 0 for s in slopes) / len(slopes)
    total = slope * (len(vals) - 1)
    if abs(total) >= 2 * sigma and (rising >= 0.7 or rising <= 0.3):
        return {"total": total, "n": len(vals)}
    return None


def sensor_checks(readings, bases, quiet):
    """readings: this node's readings oldest first, every phase, ending with the one under review.
    quiet: per metric, its earlier raw-water values that were not themselves unusual."""
    latest, out = readings[-1], []
    for m in METRICS:
        v, (lo, hi) = latest[m], PHYSICAL[m]
        run = 0
        for r in reversed(readings):
            if r[m] != v:
                break
            run += 1
        drift = trend(quiet[m], bases[m]["sigma"])
        if not lo <= v <= hi:
            out.append({"metric": m, "status": "fault", "note": f"{LABEL[m].capitalize()} of {v} is outside what the sensor can read."})
        elif run >= STUCK_RUN[m]:
            out.append({"metric": m, "status": "fault", "note": f"{LABEL[m].capitalize()} has read exactly {fmt(m, v)} for {run} readings in a row, so the sensor looks stuck."})
        elif m == "tds" and v == 0 and latest.get("phase") == "before":
            out.append({"metric": m, "status": "check", "note": "Dissolved solids read 0 ppm on unfiltered water. The probe may not have been in the water."})
        elif m == "clarity" and v == 0:
            out.append({"metric": m, "status": "check", "note": "Transparency read 0.00. Something may be blocking the light path."})
        elif drift:
            way = "up" if drift["total"] > 0 else "down"
            out.append({"metric": m, "status": "check", "note": f"{LABEL[m].capitalize()} has trended {way} by about {fmt(m, abs(drift['total']))} over the last {drift['n']} ordinary readings. That is either the sensor drifting or the water changing; a calibration check tells which."})
        else:
            out.append({"metric": m, "status": "ok", "note": ""})
    return out


# ---------------------------------------------------------------- layer 3: the neighbours
def peer_comparison(lead, direction, peers):
    """peers: [{"node", "name", "sim", "km", "reading", "history"}], each with its latest raw-water
    reading and the ones before it. Regional means at least two neighbours, and at least half of
    them, are unusual on the same reading in the same direction."""
    rows = []
    for p in peers:
        if not p.get("reading"):
            continue
        base = baseline([h[lead] for h in p.get("history", [])], lead)
        z = (p["reading"][lead] - base["median"]) / base["sigma"]
        rows.append({"node": p["node"], "name": p["name"], "sim": bool(p["sim"]), "km": p["km"],
                     "value": p["reading"][lead], "z": round(z, 1), "moved": z * direction >= Z_OUT})
    moved = [r for r in rows if r["moved"]]
    scope = "unknown" if not rows else "regional" if len(moved) >= 2 and len(moved) * 2 >= len(rows) else "local"
    return {"scope": scope, "n": len(rows), "moved": len(moved), "simulated": sum(r["sim"] for r in rows), "nodes": rows}


# ---------------------------------------------------------------- the verdict
def analyse(reading, earlier, peers=()):
    """reading: the raw-water reading under review. earlier: the same node's readings before it,
    oldest first, every phase. peers: see peer_comparison. Returns every layer and a verdict."""
    raw = [r for r in earlier if r.get("phase") == "before"]
    bases = {m: baseline([r[m] for r in raw], m) for m in METRICS}
    zrow = lambda r: [(r[m] - bases[m]["median"]) / bases[m]["sigma"] for m in METRICS]
    z = dict(zip(METRICS, zrow(reading)))
    quiet = {m: [r[m] for r in raw if abs((r[m] - bases[m]["median"]) / bases[m]["sigma"]) < Z_OUT] for m in METRICS}
    sensor = sensor_checks(list(earlier) + [reading], bases, quiet)

    # The control charts ask whether the last few pours sit away from where the node used to be,
    # so their reference is the history before those pours (when there is enough of it).
    older = raw[:-RECENT] if len(raw) - RECENT >= MIN_HISTORY else raw
    rows = []
    for m in METRICS:
        reference = baseline([r[m] for r in older], m)
        charts = control_charts([r[m] for r in raw[-RECENT:]] + [reading[m]], reference)
        rows.append({"metric": m, "value": reading[m], **bases[m], "z": round(z[m], 1), **charts})
    distance = mahalanobis([z[m] for m in METRICS], [zrow(r) for r in raw])

    lead = max(METRICS, key=lambda m: abs(z[m]))
    direction = 1 if z[lead] >= 0 else -1
    repeat = 1                                         # how many raw-water readings in a row were unusual the same way
    for r in reversed(raw):
        if (r[lead] - bases[lead]["median"]) / bases[lead]["sigma"] * direction < Z_OUT:
            break
        repeat += 1
    unusual = abs(z[lead]) >= Z_OUT or distance >= D_OUT
    persisting = [r for r in rows if r["ewma_signal"] or r["cusum_signal"]]
    near = peer_comparison(lead, direction, peers)
    faults = [s for s in sensor if s["status"] == "fault"]
    out_of_range = reading.get("verdict") not in (None, "SAFE")

    if faults:
        kind, severity = "sensor_fault", 1
    elif unusual and near["scope"] == "regional":
        kind, severity = "regional_shift", 1
    elif unusual:
        kind, severity = "local_event", 2 if out_of_range and repeat >= 2 else 1
    elif persisting:
        kind, severity = "persistent_shift", 1
    else:
        kind, severity = "normal", 0

    # the evidence, as sentences that carry their numbers and say where each came from
    b = bases[lead]
    where = (f"this site's own median of {fmt(lead, b['median'])} over {b['n']} earlier pours" if b["source"] == "history"
             else f"a typical {fmt(lead, b['median'])} for water around Princeton (this site has only {b['n']} earlier pour{'' if b['n'] == 1 else 's'})")
    evidence = [s["note"] for s in sensor if s["status"] != "ok"]
    if unusual:
        evidence.append(f"Measured: {LABEL[lead]} read {fmt(lead, reading[lead])}, {abs(z[lead]):.1f} spreads "
                        f"{'above' if direction > 0 else 'below'} {where}.")
        evidence.append("Measured: it is the only unusual pour in a row, so a second pour would confirm it." if repeat < 2
                        else f"Measured: {repeat} pours in a row have been unusual the same way.")
    else:
        evidence.append(f"Measured: all three readings are within {Z_OUT:.0f} spreads of normal for this site "
                        f"({LABEL[lead]} is the furthest, at {abs(z[lead]):.1f}).")
    for r in persisting:
        if abs(r["z"]) < Z_OUT:
            evidence.append(f"Measured: {LABEL[r['metric']]} has run {'high' if r['direction'] == 'up' else 'low'} for several "
                            f"pours (EWMA {r['ewma']:+.2f} against a limit of {r['ewma_limit']:.2f}, CUSUM {r['cusum']:.1f} against {r['cusum_limit']:.0f}), "
                            "a small shift that persists.")
    if near["n"] and unusual:
        label = "simulated " if near["simulated"] == near["n"] else ""
        count = f"{near['moved']} of the {near['n']}" if near["moved"] else f"none of the {near['n']}"
        evidence.append(f"{'Simulated' if label else 'Measured'}: {count} {label}nodes nearby {'is' if near['moved'] == 1 else 'are'} unusual the same way, "
                        + ("so this looks regional, not local." if near["scope"] == "regional" else "so this looks local to this site."))

    return {"reading": {k: reading.get(k) for k in ("id", "ts", "node", "test", "phase", "ph", "tds", "clarity", "verdict")},
            "sensor": sensor, "baseline": rows, "multivariate": {"distance": distance, "limit": D_OUT, "flag": distance >= D_OUT},
            "lead": {"metric": lead, "z": round(z[lead], 1), "direction": "up" if direction > 0 else "down"},
            "repeat": repeat, "peers": near, "kind": kind, "kind_words": KIND_WORDS[kind],
            "severity": severity, "severity_words": SEVERITY_WORDS[severity], "evidence": evidence}


# ---------------------------------------------------------------- a report from the checks alone
def rule_report(case, result, filters):
    """The report when no model is available (no key, no internet, or the investigator timed out):
    the same summary, findings and actions, written from the checks by fixed rules.
    case: {"filter", "before", "after"}. filters: the gateway's filter-life list."""
    b, a, used = case["before"], case["after"], case.get("filter")
    name = {"ZEROWATER": "ZeroWater", "BRITA": "Brita Elite"}.get(used)
    lead = result["lead"]["metric"] if result["kind"] != "normal" else ("clarity" if b.get("verdict") == "CLOUDY" else "tds")
    back = a.get("verdict") == "SAFE"
    if name:
        summary = (f"{name} took this cup's {LABEL[lead]} from {fmt(lead, b[lead])} to {fmt(lead, a[lead])}, "
                   + ("and the retest is back in range." if back else "but the retest is still out of range."))
    else:
        summary = f"This cup was not filtered. Its retest read {fmt('tds', a['tds'])}, pH {fmt('ph', a['ph'])} and transparency {fmt('clarity', a['clarity'])}."
    findings = list(result["evidence"])
    actions = []
    for f in filters or []:
        if f.get("filter") == used and f.get("status") in ("REPLACE", "REPLACE_SOON"):
            findings.append(f"Measured: the {name} cartridge is marked {'for replacement' if f['status'] == 'REPLACE' else 'as nearly spent'}.")
            actions.append(f"Replace the {name} cartridge before the next pour.")
    if result["kind"] == "sensor_fault":
        actions.insert(0, "Check and recalibrate the sensor before trusting this reading.")
    elif result["kind"] == "local_event":
        actions.append("Pour a second cup from the same source to confirm the reading." if result["repeat"] < 2
                       else "Find out what changed at this source: the same unusual reading has repeated.")
        actions.append("Have the source tested by a lab before relying on it: this device reads only pH, dissolved solids and transparency.")
    elif result["kind"] == "regional_shift":
        actions.append("Compare with the latest published samples: several nodes moved together, which points to the source, not this site.")
    elif result["kind"] == "persistent_shift":
        actions.append("Recalibrate the sensor, then watch the next few pours: a small shift has persisted.")
    if name and not back:
        actions.insert(0, f"Do not rely on {name} for this water: the retest is still out of range.")
    if not actions:
        actions.append("Nothing to do. Keep measuring.")
    severity = 2 if (name and not back) else result["severity"]
    return {"summary": summary, "findings": findings[:5], "actions": actions[:3], "severity": severity}


# ---------------------------------------------------------------- a notice, from fixed templates
# A draft for the people who use this water. Nothing sends it. The required sentence is in every one.
NOTICE_REQUIRED = "Clarity reads only pH, dissolved solids and transparency. It cannot detect lead, bacteria or any specific contaminant."
NOTICE_TEMPLATES = {
    "back_in_range": "Clarity measured a cup of water at {site}. It read {problem} and was sent through {filter}. "
                     "On the retest, pH, dissolved solids and transparency all read in range.",
    "still_out_of_range": "Clarity measured a cup of water at {site}. It read {problem}, and after {filter} the retest was "
                          "still out of range. Have this source tested by a certified lab before relying on it.",
    "no_filter_needed": "Clarity measured a cup of water at {site}. pH, dissolved solids and transparency all read in "
                        "range, so it was not filtered.",
    "not_filtered": "Clarity measured a cup of water at {site}. It read {problem}, which neither of its filters is made "
                    "to correct. Have this source tested by a certified lab before relying on it.",
    "sensor_fault": "A sensor on the Clarity node at {site} needs checking, so its latest readings should not be relied "
                    "on until it has been recalibrated.",
}
PROBLEM = {"HIGH_TDS": "high in dissolved solids ({tds} ppm)", "CLOUDY": "cloudy (transparency {clarity:.2f})",
           "PH_WARN": "outside the usual pH range (pH {ph:.1f})", "SAFE": "in range"}


def notice_template(case, result):
    name = {"ZEROWATER": "ZeroWater", "BRITA": "Brita Elite"}.get(case.get("filter"))
    if result["kind"] == "sensor_fault":
        return "sensor_fault"
    if not name:
        return "no_filter_needed" if case["before"].get("verdict") == "SAFE" else "not_filtered"
    return "back_in_range" if case["after"].get("verdict") == "SAFE" else "still_out_of_range"


def notice_for(case, result, site):
    b = case["before"]
    filled = NOTICE_TEMPLATES[notice_template(case, result)].format(
        site=site or "this site", filter={"ZEROWATER": "ZeroWater", "BRITA": "Brita Elite"}.get(case.get("filter"), ""),
        problem=PROBLEM.get(b.get("verdict"), "out of range").format(**b))
    return f"{filled} {NOTICE_REQUIRED}"


def notice_ok(text):
    """A model-written notice is used only if it keeps the required sentence and promises nothing."""
    low = (text or "").lower()
    return NOTICE_REQUIRED in (text or "") and not any(w in low for w in (" safe", "drink", "healthy", "clean to"))
