"""Layered detection: what the numbers say, worked out before any model is asked.

There is almost no labelled data for a new sensor, so this is statistics, in three layers:

  1. Sensor checks      Is the sensor believable? Out of range, stuck on one value, reading
                        zero, or trending slowly one way. A sensor fault is not a water event.
  2. This node's own    Robust z-scores (median and MAD) against the node's own history, EWMA
     baseline           and CUSUM control charts for small shifts that persist, and one
                        multivariate distance (Mahalanobis) across the readings (pH is left
                        out of all of this while the tank only estimates it).
  3. Peer comparison    Did the neighbours move the same way? Then it is regional (a change of
                        source, the weather). Only this node? Then it is local.

Then one verdict: normal, sensor fault, local event, regional shift or persistent shift, with
a severity and the evidence for it as plain sentences that carry their numbers.

The investigator's agents read these results through tools. They explain and decide what to
do next; they do not compute. Everything here is a pure function of lists of readings (no
database, no network), so it can be tested alone: python test_analysis.py
"""
import math
import os
import random
import statistics
from datetime import datetime

METRICS = ("ph", "tds", "clarity")
# The tank's current sketch works pH out from dissolved solids (PH_FROM_TDS 1): it is an estimate, not a
# reading, and for clean water it is exactly 7.0 every time. So by default pH is carried along and shown, but
# it is not checked as a sensor, cannot be the reading a verdict rests on, and adds nothing to the combined
# distance (it would count dissolved solids twice). PH_ESTIMATED=0 in the environment treats it as a reading
# again; set it only once the probe is calibrated and the sketch is flashed with PH_FROM_TDS 0.
PH_ESTIMATED = os.getenv("PH_ESTIMATED", "1").strip() != "0"
MEASURED = tuple(m for m in METRICS if not (PH_ESTIMATED and m == "ph"))


def ph_is_estimated(reading=None):
    """Per-reading provenance wins; only legacy packets use the gateway default."""
    value = (reading or {}).get("ph_est")
    if value is None:
        return PH_ESTIMATED
    if value in (False, 0, "0", "false"):
        return False
    if value in (True, 1, "1", "true"):
        return True
    return PH_ESTIMATED


def measured_metrics(reading=None):
    return tuple(m for m in METRICS if m != "ph" or not ph_is_estimated(reading))


def measured_verdict(reading):
    """Screening thresholds use measured signals, never an estimated pH value."""
    if reading["tds"] > 300:
        return "HIGH_TDS"
    if reading["clarity"] < 0.7:
        return "CLOUDY"
    if not ph_is_estimated(reading) and not 6.5 <= reading["ph"] <= 8.5:
        return "PH_WARN"
    return "SAFE"


def _case_estimated(reading_or_case=None):
    value = reading_or_case or {}
    if "before" in value:
        return any(ph_is_estimated(r) for r in (value.get("before"), value.get("after")) if r)
    return ph_is_estimated(value)

LABEL = {"ph": "pH", "tds": "dissolved solids", "clarity": "transparency"}
PHYSICAL = {"ph": (0, 14), "tds": (0, 5000), "clarity": (0, 1)}       # what each sensor can read
# Used until a node has enough history of its own: (typical value, spread) for water around Princeton
TYPICAL = {"ph": (7.5, 0.3), "tds": (180, 70), "clarity": (0.95, 0.04)}
FLOOR = {"ph": 0.1, "tds": 10, "clarity": 0.02}   # smallest spread worth believing (sensor noise)
MIN_HISTORY = 8                                   # readings before a node's own baseline is used
CLIP = 2.0                                        # the control charts count no single pour as more than this many spreads
RECENT = 10                                       # pours the control charts look across
STUCK_RUN = {"ph": 8, "tds": 5, "clarity": 8}     # identical readings in a row that mean "stuck"
SAME_HOURS = 3                                    # "the same time of day": within this many hours of it, either side
MIN_SAME = 12                                     # compare with the same time of day only once there are this many such pours
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


def _inverse(matrix):
    """Small pivoted inverse, for either two or three independent measurements."""
    size = len(matrix)
    rows = [list(row) + [float(i == j) for j in range(size)] for i, row in enumerate(matrix)]
    for i in range(size):
        pivot = max(range(i, size), key=lambda j: abs(rows[j][i]))
        if abs(rows[pivot][i]) < 1e-9:
            return None
        rows[i], rows[pivot] = rows[pivot], rows[i]
        scale = rows[i][i]
        rows[i] = [x / scale for x in rows[i]]
        for j in range(size):
            if j != i:
                scale = rows[j][i]
                rows[j] = [a - scale * b for a, b in zip(rows[j], rows[i])]
    return [row[size:] for row in rows]


def mahalanobis(z, past_z):
    """Distance across only the independent measured signals; estimates are not dimensions."""
    size, n = len(z), len(past_z)
    corr = [[float(i == j) for j in range(size)] for i in range(size)]
    if n >= MIN_HISTORY:
        cols = [[max(-4.0, min(4.0, row[k])) for row in past_z] for k in range(size)]
        means = [statistics.fmean(c) for c in cols]
        sds = [statistics.pstdev(c) for c in cols]
        keep = 1 - max(0.3, MIN_HISTORY / (n + MIN_HISTORY))
        for i in range(size):
            for j in range(i + 1, size):
                if sds[i] > 1e-9 and sds[j] > 1e-9:
                    cov = statistics.fmean((cols[i][t] - means[i]) * (cols[j][t] - means[j]) for t in range(n))
                    corr[i][j] = corr[j][i] = keep * cov / (sds[i] * sds[j])
    inv = _inverse(corr) or [[float(i == j) for j in range(size)] for i in range(size)]
    zc = [max(-12.0, min(12.0, v)) for v in z]
    d2 = sum(zc[i] * inv[i][j] * zc[j] for i in range(size) for j in range(size))
    return round(math.sqrt(max(0.0, d2)), 2)


def hour_of(ts):
    """Clock hour from an ISO timestamp, or None for legacy readings without a clock."""
    try:
        t = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return t.hour + t.minute / 60 + t.second / 3600
    except (TypeError, ValueError):
        return None


def isolation_score(point, history, trees=48):
    """Deterministic isolation-forest stretch score; diagnostic only, never a verdict."""
    if len(history) < MIN_HISTORY:
        return None
    rng = random.Random(26)
    count = min(64, len(history))
    depth_limit = math.ceil(math.log2(count))
    def adjustment(n):
        return 0.0 if n < 2 else 2 * sum(1 / k for k in range(1, n)) - 2 * (n - 1) / n
    def path(rows, depth):
        if len(rows) < 2 or depth >= depth_limit:
            return depth + adjustment(len(rows))
        choices = [(k, min(r[k] for r in rows), max(r[k] for r in rows)) for k in range(len(point))]
        choices = [c for c in choices if c[2] > c[1]]
        if not choices:
            return depth + adjustment(len(rows))
        k, lo, hi = rng.choice(choices)
        split = rng.uniform(lo, hi)
        subset = [r for r in rows if (r[k] < split) == (point[k] < split)]
        return path(subset, depth + 1)
    lengths = [path(rng.sample(history, count), 0) for _ in range(trees)]
    return round(2 ** (-statistics.fmean(lengths) / adjustment(count)), 3)


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
        if m not in measured_metrics(latest):
            out.append({"metric": m, "status": "ok", "included": False, "estimated": True,
                        "note": "pH is estimated from dissolved solids, so it is excluded from sensor checks."})
            continue
        v, (lo, hi) = latest[m], PHYSICAL[m]
        run = 0
        for r in reversed(readings):
            if (m == "ph" and ph_is_estimated(r)) or r[m] != v:
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
        if not p.get("reading") or (lead == "ph" and ph_is_estimated(p["reading"])):
            continue
        base = baseline([h[lead] for h in p.get("history", []) if lead != "ph" or not ph_is_estimated(h)], lead)
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
    raw_all = [r for r in earlier if r.get("phase") == "before"]
    hour = hour_of(reading.get("ts"))
    same = [r for r in raw_all if hour is not None and hour_of(r.get("ts")) is not None
            and min(abs(hour_of(r["ts"]) - hour), 24 - abs(hour_of(r["ts"]) - hour)) <= SAME_HOURS]
    if len(same) < MIN_SAME:
        same = []
    raw = same or raw_all
    metrics = measured_metrics(reading)
    history = {m: [r for r in raw if m != "ph" or not ph_is_estimated(r)] for m in METRICS}
    bases = {m: baseline([r[m] for r in history[m]], m) for m in METRICS}
    zrow = lambda r: [(r[m] - bases[m]["median"]) / bases[m]["sigma"] for m in metrics]
    z = {m: (reading[m] - bases[m]["median"]) / bases[m]["sigma"] if m in metrics else 0.0 for m in METRICS}
    quiet = {m: [r[m] for r in history[m] if abs((r[m] - bases[m]["median"]) / bases[m]["sigma"]) < Z_OUT] for m in METRICS}
    sensor = sensor_checks(list(earlier) + [reading], bases, quiet)

    rows = []
    for m in METRICS:
        past = history[m]
        older = past[:-RECENT] if len(past) - RECENT >= MIN_HISTORY else past
        reference = baseline([r[m] for r in older], m)
        charts = control_charts([r[m] for r in past[-RECENT:]] + [reading[m]], reference) if m in metrics else {
            "ewma": 0.0, "ewma_limit": 0.0, "ewma_signal": False,
            "cusum": 0.0, "cusum_limit": 0.0, "cusum_signal": False, "direction": "up"}
        rows.append({"metric": m, "value": reading[m], **bases[m], "z": round(z[m], 1), **charts,
                     "included": m in metrics, "estimated": m == "ph" and ph_is_estimated(reading)})
    joint_history = [r for r in raw if "ph" not in metrics or not ph_is_estimated(r)]
    distance = mahalanobis(zrow(reading), [zrow(r) for r in joint_history])
    # The previous three-signal threshold is retained; for two signals use its matching 99% chi radius.
    distance_limit = D_OUT if len(metrics) == 3 else round(math.sqrt(-2 * math.log(0.01)), 2)
    isolation = isolation_score(zrow(reading), [zrow(r) for r in joint_history])
    lead = max(metrics, key=lambda m: abs(z[m]))
    direction = 1 if z[lead] >= 0 else -1
    repeat = 1                                         # how many raw-water readings in a row were unusual the same way
    for r in reversed(history[lead]):
        if (r[lead] - bases[lead]["median"]) / bases[lead]["sigma"] * direction < Z_OUT:
            break
        repeat += 1
    unusual = abs(z[lead]) >= Z_OUT or distance >= distance_limit
    persisting = [r for r in rows if (r["ewma_signal"] or r["cusum_signal"]) and r["metric"] in metrics]
    near = peer_comparison(lead, direction, peers)
    faults = [s for s in sensor if s["status"] == "fault"]
    out_of_range = measured_verdict(reading) != "SAFE"

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
    where = (f"this site's own median of {fmt(lead, b['median'])} over {b['n']} earlier pours{' at this time of day' if same else ''}" if b["source"] == "history"
             else f"a typical {fmt(lead, b['median'])} for water around Princeton (this site has only {b['n']} earlier pour{'' if b['n'] == 1 else 's'})")
    evidence = [s["note"] for s in sensor if s["status"] != "ok"]
    if unusual:
        evidence.append(f"Measured: {LABEL[lead]} read {fmt(lead, reading[lead])}, {abs(z[lead]):.1f} spreads "
                        f"{'above' if direction > 0 else 'below'} {where}.")
        evidence.append("Measured: it is the only unusual pour in a row, so a second pour would confirm it." if repeat < 2
                        else f"Measured: {repeat} pours in a row have been unusual the same way.")
    else:
        evidence.append(f"Measured: {'all three' if len(metrics) == 3 else 'both'} readings are within {Z_OUT:.0f} spreads of normal for this site "
                        f"({LABEL[lead]} is the furthest, at {abs(z[lead]):.1f}).")
    # A spike, seen in hindsight: the pour before this one stood alone, and this one is back to normal.
    one_off = None
    if not unusual and raw_all:
        last = raw_all[-1]
        comparable = [m for m in metrics if m != "ph" or not ph_is_estimated(last)]
        zl = {m: (last[m] - bases[m]["median"]) / bases[m]["sigma"] for m in comparable}
        far = max(comparable, key=lambda m: abs(zl[m]))
        alone = len(raw_all) < 2 or all(abs((raw_all[-2][m] - bases[m]["median"]) / bases[m]["sigma"]) < Z_OUT
                                      for m in comparable if m != "ph" or not ph_is_estimated(raw_all[-2]))
        if abs(zl[far]) >= Z_OUT and alone:
            one_off = {"metric": far, "value": last[far], "z": round(zl[far], 1), "test": last.get("test")}
            evidence.append(f"Measured: the pour before this one read {LABEL[far]} of {fmt(far, last[far])}, {abs(zl[far]):.1f} spreads from normal, "
                            "and this one is back to normal, so that reading was a one-off.")
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

    return {"reading": {**{k: reading.get(k) for k in ("id", "ts", "node", "test", "phase", "ph", "tds", "clarity", "verdict")}, "ph_est": ph_is_estimated(reading)},
            "sensor": sensor, "baseline": rows,
            "multivariate": {"distance": distance, "limit": distance_limit, "flag": distance >= distance_limit, "isolation": isolation, "dimensions": len(metrics)},
            "measured_metrics": list(metrics),
            "scope": {"kind": "time_of_day", "hours": SAME_HOURS, "n": len(same)} if same else {"kind": "all", "n": len(raw)},
            "one_off_before": one_off,
            "lead": {"metric": lead, "z": round(z[lead], 1), "direction": "up" if direction > 0 else "down"},
            "repeat": repeat, "peers": near, "kind": kind, "kind_words": KIND_WORDS[kind],
            "severity": severity, "severity_words": SEVERITY_WORDS[severity], "evidence": evidence}


def ph_retest_unverified(case):
    before, after = case.get("before"), case.get("after")
    return bool(before and after and not ph_is_estimated(before) and ph_is_estimated(after)
                and not 6.5 <= before["ph"] <= 8.5)


# ---------------------------------------------------------------- a report from the checks alone
def rule_report(case, result, filters):
    """The report when no model is available (no key, no internet, or the investigator timed out):
    the same summary, findings and actions, written from the checks by fixed rules.
    case: {"filter", "before", "after"}. filters: the gateway's filter-life list."""
    b, a, used = case["before"], case["after"], case.get("filter")
    name = {"ZEROWATER": "ZeroWater", "BRITA": "Brita Elite"}.get(used)
    # A filter comparison concerns its targeted measured signal, never derived pH or another lead metric.
    lead = "clarity" if used == "BRITA" else "tds"
    unverified = ph_retest_unverified(case)
    back = measured_verdict(a) == "SAFE" and not unverified
    if name:
        summary = (f"{name} took this cup's {LABEL[lead]} from {fmt(lead, b[lead])} to {fmt(lead, a[lead])}, "
                   + ("but pH was only estimated on the retest, so the earlier pH warning is not resolved." if unverified
                      else "and the retest is back in range." if back else "but the retest is still out of range."))
    else:
        summary = (f"This cup was not filtered. Its retest read {fmt('tds', a['tds'])}, pH {fmt('ph', a['ph'])}"
                   f"{' (estimated)' if ph_is_estimated(a) else ''} and transparency {fmt('clarity', a['clarity'])}.")
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
        actions.append(f"Have the source tested by a lab before relying on it: this device reads only {measurement_words(case)}.")
    elif result["kind"] == "regional_shift":
        actions.append("Compare with the latest published samples: several nodes moved together, which points to the source, not this site.")
    elif result["kind"] == "persistent_shift":
        actions.append("Recalibrate the sensor, then watch the next few pours: a small shift has persisted.")
    if name and not back:
        actions.insert(0, "Retest pH with a calibrated probe: an estimate cannot confirm the earlier measurement." if unverified
                       else f"Do not rely on {name} for this water: the retest is still out of range.")
    if not actions:
        actions.append("Nothing to do. Keep measuring.")
    severity = 2 if (name and not back) else result["severity"]
    return {"summary": summary, "findings": findings[:5], "actions": actions[:3], "severity": severity}


# ---------------------------------------------------------------- a notice, from fixed templates
# A draft for the people who use this water. Nothing sends it. The required sentence is in every one.
#
# While pH is an estimate (PH_ESTIMATED, at the top of this file), no notice speaks of it as something Clarity read.
def measurement_words(reading_or_case=None):
    return "dissolved solids and transparency" if _case_estimated(reading_or_case) else "pH, dissolved solids and transparency"


def notice_required(reading_or_case=None):
    return f"Clarity reads only {measurement_words(reading_or_case)}. It cannot detect lead, bacteria or any specific contaminant."


def notice_templates(reading_or_case=None):
    reads = measurement_words(reading_or_case)
    in_range = f"{reads} {'both' if _case_estimated(reading_or_case) else 'all'} read in range"
    return {
        "back_in_range": "Clarity measured a cup of water at {site}. It read {problem} and was sent through {filter}. "
                         f"On the retest, {in_range}.",
        "still_out_of_range": "Clarity measured a cup of water at {site}. It read {problem}, and after {filter} the retest was "
                              "still out of range. Have this source tested by a certified lab before relying on it.",
        "no_filter_needed": "Clarity measured a cup of water at {site}. " + in_range[0].upper() + in_range[1:]
                            + ", so it was not filtered.",
        "not_filtered": "Clarity measured a cup of water at {site}. It read {problem}, which neither of its filters is made "
                        "to correct. Have this source tested by a certified lab before relying on it.",
        "ph_unverified": "Clarity's first pH measurement at {site} was outside the usual range. The retest pH was estimated, "
                         "so the earlier pH warning remains unverified. Retest with a calibrated probe.",
        "sensor_fault": "A sensor on the Clarity node at {site} needs checking, so its latest readings should not be relied "
                        "on until it has been recalibrated.",
    }


READS = measurement_words()
IN_RANGE = f"{READS} {'both' if PH_ESTIMATED else 'all'} read in range"
NOTICE_REQUIRED = notice_required()
NO_DISINFECTION = "A pitcher filter does not disinfect."
NOTICE_TEMPLATES = notice_templates()
PROBLEM = {"HIGH_TDS": "high in dissolved solids ({tds} ppm)", "CLOUDY": "cloudy (transparency {clarity:.2f})",
           "PH_WARN": "outside the usual pH range (pH {ph:.1f})", "SAFE": "in range"}


def notice_template(case, result):
    name = {"ZEROWATER": "ZeroWater", "BRITA": "Brita Elite"}.get(case.get("filter"))
    if result["kind"] == "sensor_fault":
        return "sensor_fault"
    if ph_retest_unverified(case):
        return "ph_unverified"
    if not name:
        return "no_filter_needed" if measured_verdict(case["before"]) == "SAFE" else "not_filtered"
    return "back_in_range" if measured_verdict(case["after"]) == "SAFE" else "still_out_of_range"


def notice_for(case, result, site):
    b = case["before"]
    filled = notice_templates(case)[notice_template(case, result)].format(
        site=site or "this site", filter={"ZEROWATER": "ZeroWater", "BRITA": "Brita Elite"}.get(case.get("filter"), ""),
        problem=PROBLEM.get(measured_verdict(b), "out of range").format(**b))
    cloudy = b.get("verdict") == "CLOUDY" and case.get("filter") in ("ZEROWATER", "BRITA")
    return f"{filled} {NO_DISINFECTION + ' ' if cloudy else ''}{notice_required(case)}"


def notice_ok(text, reading_or_case=None):
    """A model-written notice is used only if it keeps the required sentence and promises nothing."""
    low = (text or "").lower()
    return notice_required(reading_or_case) in (text or "") and not any(w in low for w in (" safe", "drink", "healthy", "clean to"))


# ---------------------------------------------------------------- who to ask (triage)
# The checks decide which of the investigator's specialists a case needs, and why. An ordinary
# pour needs two; a sensor fault needs the sensor looked at before anything is said about the
# water. The lead agent is handed this plan and may add to it, but has to say why.
def plan(case, result):
    """-> [{"agent", "why"}] for one filter run, most important first."""
    kind, used = result["kind"], case.get("filter") in ("ZEROWATER", "BRITA")
    after_out = bool(case.get("after")) and (measured_verdict(case["after"]) != "SAFE" or ph_retest_unverified(case))
    flagged = [s for s in result["sensor"] if s["status"] != "ok"]
    ask = []
    if kind == "sensor_fault" or flagged:
        ask.append(("sensor-health", "a sensor check did not pass, so the reading has to be believed before it is explained"))
    if kind in ("local_event", "regional_shift", "persistent_shift"):
        ask.append(("analyst", {"local_event": "the pour is unusual for this site", "regional_shift": "the pour is unusual for this site",
                                "persistent_shift": "a small shift has persisted across recent pours"}[kind]))
    if kind in ("local_event", "regional_shift"):
        ask.append(("network", "to tell a local change from a regional one, and to set it against published samples"))
    if used or after_out or kind in ("sensor_fault", "persistent_shift"):
        ask.append(("maintenance", "a filter was used" if used else "upkeep may be what this needs"))
    ask.append(("comms", "every report carries a notice"))
    return [{"agent": a, "why": w} for a, w in ask]


# ---------------------------------------------------------------- checking what the agents wrote
# The agents may explain; they may not make up figures. Every number in their report has to appear
# in the case or in something a tool returned during the run. Small counts and the fixed limits the
# agents are told about are allowed. A finding or action with a figure that cannot be traced is dropped.
import re as _re

ALLOWED = {300, 500, 6.5, 8.5, 0.7, 6, 450, 120}       # the limits and makers' ratings in the agents' instructions
_NUMBER = _re.compile(r"(?<![\w.])\d+(?:\.\d+)?")


def _numbers(text):
    return [m.group(0) for m in _NUMBER.finditer(text or "")]


def ground(report, evidence):
    """report: {"summary", "findings", "actions", "sections"}; evidence: text of the case and of every
    tool result. -> the report with untraceable findings and actions removed, and a "check" record."""
    known = {float(n) for n in _numbers(evidence)} | {float(a) for a in ALLOWED}

    def traced(token):
        value, places = float(token), len(token.split(".")[1]) if "." in token else 0
        if value == int(value) and value < 13:                      # small counts are prose, not figures
            return None
        return value in known or any(round(k, places) == value for k in known)

    figures = traced_n = 0
    untraced = []

    def ok(where, text):
        nonlocal figures, traced_n
        bad = []
        for token in _numbers(text):
            t = traced(token)
            if t is None:
                continue
            figures += 1
            traced_n += bool(t)
            if not t:
                bad.append(token)
        if bad:
            untraced.append({"where": where, "text": text, "numbers": bad})
        return not bad

    findings = [f for f in report.get("findings", []) if ok("finding", f)]
    actions = [a for a in report.get("actions", []) if ok("action", a)]
    summary_ok = ok("summary", report.get("summary", ""))
    sections = [{**s, "traced": ok(f"section:{s.get('agent')}", s.get("text", ""))} for s in report.get("sections", [])]
    dropped = (len(report.get("findings", [])) - len(findings)) + (len(report.get("actions", [])) - len(actions))
    return ({**report, "findings": findings, "actions": actions, "sections": sections},
            {"figures": figures, "traced": traced_n, "dropped": dropped, "summary_ok": summary_ok, "untraced": untraced[:6]})
