"""No-clock, no-key checks of radio replay/targeting and seeded stress simulation."""
import json

import benchmark_simulations as benchmark
import localize
import mock
import simulation


class Clock:
    now = 0.0
    def __call__(self):
        return self.now


def device(scenario="cycle", seed=26):
    clock = Clock()
    dev = mock.MockDevice(period=25, scenario=scenario, seed=seed, session="test-session", clock=clock, sleeper=lambda _: None)
    return dev, clock


def take(dev, clock, at):
    clock.now = at
    raw = dev.readline()
    return json.loads(raw) if raw else None


a, ca = device("duplicate")
b, cb = device("duplicate")
first = take(a, ca, 3)
assert first == take(b, cb, 3), "fixed seed, session and time must reproduce metrics and identity"
replay = take(a, ca, 3.4)
assert replay == first, "retransmission must retain the original identity and body"
assert len(json.dumps(first, separators=(",", ":")).encode()) < 250, "mock payload must fit the radio"
assert first["ph_est"] == 1 and first["ph"] == mock.estimated_ph(first["tds"])
second = take(a, ca, 28)
assert second["seq"] != first["seq"] and second["session"] == first["session"]
assert take(a, ca, 28.4) == second, "the second duplicate is also a replay, not a retest"
command = {"cmd": "filter", "node": a.node, "test": second["test"], "filter": "BRITA", "session": a.session, "seq": second["seq"]}
missing_identity = {k: v for k, v in command.items() if k not in ("session", "seq")}
missing_sequence = {k: v for k, v in command.items() if k != "seq"}
missing_session = {k: v for k, v in command.items() if k != "session"}
for wrong in (missing_identity, missing_sequence, missing_session, dict(command, node="tank-02"),
              dict(command, test=20), dict(command, seq=999), dict(command, seq=True),
              dict(command, seq=1.5), dict(command, seq=-1), dict(command, seq=0x100000000),
              dict(command, seq=str(second["seq"])), dict(command, session="old-boot"),
              dict(command, test=True), dict(command, filter="INVALID")):
    a.write(json.dumps(wrong).encode())
assert not a.ai_choice, "wrong target, stale identity and malformed commands must not steer the mock"
a.write(json.dumps(command).encode())
assert a.ai_choice[second["test"]] == "BRITA"
a.write(json.dumps(dict(command, filter="ZEROWATER")).encode())
assert a.ai_choice[second["test"]] == "BRITA", "consume once: a second matching command cannot change the decision"
retest = take(a, ca, 43)
assert retest["test"] == second["test"] and retest["phase"] == "after" and retest["seq"] > second["seq"]
assert retest["clarity"] >= 0.86 and retest["tds"] <= second["tds"], "the accepted Brita command should be used for the simulated retest: clearer, solids about the same"
third = take(a, ca, 53)
assert take(a, ca, 53.4) == third
assert third["filter"] == "NONE" and take(a, ca, 68) is None, "a clean cup is not filtered, so it has no retest"
fourth = take(a, ca, 78)                        # the next cup that is not clear
assert take(a, ca, 78.4) == fourth and fourth["filter"] == "BRITA"
late = {"cmd": "filter", "node": a.node, "test": fourth["test"], "filter": "ZEROWATER", "session": a.session, "seq": fourth["seq"]}
ca.now = 90
# No earlier answer was consumed for this pour: lateness itself must reject the reply.
a.write(json.dumps(late).encode())
assert fourth["test"] not in a.ai_choice
retest = take(a, ca, 93)
assert retest["test"] == fourth["test"] and retest["tds"] > 100, "late AI reply must not override the Brita rule"
assert mock.MockDevice().session != mock.MockDevice().session, "new boots must not reuse simulation identity"

fault, fc = device("sensor-fault")
values = [take(fault, fc, 3 + 25*i) for i in range(5)]
assert {r["tds"] for r in values} == {233}
assert benchmark.analysis.analyse(values[-1], values[:-1])["kind"] == "sensor_fault"
drift, dc = device("drift")
drift_history, drift_results = [], []
for i in range(35):
    reading = take(drift, dc, 3 + 25*i)
    drift_results.append(benchmark.analysis.analyse(reading, drift_history)["kind"])
    drift_history.append(reading)
assert "persistent_shift" in drift_results and "sensor_fault" not in drift_results, drift_results
regional, rc = device("regional")
raw = []
for i in range(11):
    at = 3 + i*25
    raw += [take(regional, rc, at) for _ in range(3)]
assert {r["node"] for r in raw[-3:]} == {"tank-01", "sim-01", "sim-02"}
assert all(r["tds"] > 500 for r in raw[-3:])

stress = simulation.stress_scenarios(localize.NET)
assert [s["id"] for s in stress] == [s["id"] for s in simulation.stress_scenarios(localize.NET)]
assert not set(stress[0]["unavailable"]) & set(stress[0]["quiet"])
r1 = simulation.network_benchmark(localize.NET, localize.localize, trials=1)
r2 = simulation.network_benchmark(localize.NET, localize.localize, trials=1)
assert r1 == r2, "benchmark must be reproducible without cached or magic performance numbers"
assert all(r["trials"] == 117 and 0 <= r["top1"] <= r["top3"] <= r["observed"] <= 117 for r in r1["profiles"])
assert r1["profiles"][2]["observed"] <= r1["profiles"][0]["observed"]
detect = benchmark.detection_benchmark(trials=3)
assert detect["quiet_pours"] == 360 and detect["stuck_faults_detected"] == 3 and detect["regional_shifts_detected"] == 3
assert detect["shifts_detected_within_20_pours"] >= 2, detect
print("PASS seeded replay identity, exact command targeting/deadline, before/after provenance, sensor fault/regional mock cases, and robustness/detection benchmark")
