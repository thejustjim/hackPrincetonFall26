"""Reproduce synthetic detection/localization checks without keys or hardware.

Run: python gateway/benchmark_simulations.py [--json] [--trials 2] [--seed 20261115]
No dependencies beyond the standard library; does not write files or connect to a service.
"""
import argparse
import json
import random
import statistics

import analysis
import localize
import simulation


def detection_benchmark(seed=20261115, trials=8):
    false_events = sensor_flags = total = 0
    latencies, faults, regional = [], 0, 0
    event_kinds = {"local_event", "regional_shift", "persistent_shift"}
    for trial in range(trials):
        rng = random.Random(seed + trial)
        def sample(i, tds=None):
            t = max(1, round(rng.gauss(200, 10))) if tds is None else tds
            return {"node": "synthetic", "test": i, "phase": "before", "ph": 7.0,
                    "ph_est": 1, "tds": t, "clarity": round(min(1, rng.gauss(0.95, 0.015)), 3), "verdict": "SAFE"}
        history = [sample(i) for i in range(40)]
        for i in range(40, 160):
            reading = sample(i)
            result = analysis.analyse(reading, history)
            false_events += result["kind"] in event_kinds
            sensor_flags += result["kind"] == "sensor_fault"
            total += 1
            history.append(reading)
        base = [sample(i) for i in range(40)]
        shifted = list(base)
        for step in range(1, 21):
            reading = sample(40 + step, 225 + rng.randrange(-2, 3))
            result = analysis.analyse(reading, shifted)
            shifted.append(reading)
            if result["kind"] == "persistent_shift":
                latencies.append(step)
                break
        stuck = base + [sample(40 + i, 233) for i in range(5)]
        faults += analysis.analyse(stuck[-1], stuck[:-1])["kind"] == "sensor_fault"
        peers = [{"node": f"sim-{i}", "name": f"sim-{i}", "sim": True, "km": 2,
                  "reading": sample(99, 520), "history": base} for i in range(3)]
        regional += analysis.analyse(sample(99, 520), base, peers)["kind"] == "regional_shift"
    return {"simulated": True, "seed": seed, "quiet_pours": total, "false_water_events": false_events,
            "sensor_flags": sensor_flags, "false_events_per_1000": round(false_events * 1000 / total, 2),
            "shift_trials": trials, "shifts_detected_within_20_pours": len(latencies),
            "median_persistent_shift_latency_pours": statistics.median(latencies) if latencies else None,
            "stuck_faults_detected": faults, "regional_shifts_detected": regional,
            "note": "Seeded synthetic quiet data and a 25 ppm persistent step; latency is in pours, not seconds. Estimated pH is explicitly marked. These results describe this generator, not field false-alarm rates."}


def run(seed=20261115, trials=2):
    return {"simulated": True,
            "network": simulation.network_benchmark(localize.NET, localize.localize, trials, seed),
            "detection": detection_benchmark(seed)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--seed", type=int, default=20261115)
    parser.add_argument("--trials", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.trials <= 20:
        parser.error("--trials must be between 1 and 20")
    result = run(args.seed, args.trials)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(result["network"]["note"])
        for row in result["network"]["profiles"]:
            print(f"{row['label']}: {row['observed']}/{row['trials']} observed, top1 {row['top1']}/{row['observed']}, top3 {row['top3']}/{row['observed']}, source retained {row['source_in_candidates']}/{row['observed']}")
        print(json.dumps(result["detection"], indent=2))
