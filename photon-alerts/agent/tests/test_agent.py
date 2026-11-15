import os

os.environ.pop("GOOGLE_API_KEY", None)
os.environ.pop("GEMINI_API_KEY", None)
os.environ["EVIDENCE_FILE"] = "/tmp/clarity-test-evidence.json"

from clarity_agent.agents import ClarityAgents, facts_from
from clarity_agent.data import LiveData
from clarity_agent.photos import PhotoVerdict, reply_for
from clarity_agent.safety import scrub, violates


def test_scrub_never_says_safe():
    for s in ["Your water is safe to drink.", "It's totally safe.", "Looks safe now", "verdict SAFE", "safe range", "drink it safely"]:
        out = scrub(s)
        assert not violates(out), (s, out)
    assert scrub("The water is UNSAFE.") == "The water is UNSAFE."


TEMPLATE = "Clarity ALERT: Princeton tank (tank-01) failed its test. TDS 780 ppm (EPA limit 500). Reply OK when you've seen this, or STOP."


def make(threshold=1):
    sent = []
    def send(to, text, alert_id=None):
        sent.append((list(to), text))
        return len(to)
    data = LiveData(gateway="http://127.0.0.1:9")  # unreachable: falls back to /ws state
    return ClarityAgents(data, send, mass_threshold=threshold), sent


def test_mass_alert_waits_for_operator_then_sends():
    agents, sent = make()
    a = agents.start_alert("41", "tank-01", TEMPLATE, facts_from(TEMPLATE), ["+15550000001", "+15550000002"])
    assert a.status == "pending_approval" and a.approval_id == 1
    assert sent == []  # nothing goes out before approval
    assert agents.pending()[0]["recipients"] == 2
    agents.decide(1, "approve")
    assert a.status == "sent"
    assert sent[0][0] == ["+15550000001", "+15550000002"]
    assert "780" in sent[0][1]


def test_operator_can_edit_or_reject():
    agents, sent = make()
    agents.start_alert("1", "tank-01", TEMPLATE, facts_from(TEMPLATE), ["+15550000001"])
    agents.decide(1, "edit", "Clarity: tank-01 read TDS 780 ppm (EPA limit 500). It is safe after filtering. Reply OK or STOP.")
    assert "780" in sent[0][1] and not violates(sent[0][1])
    agents.start_alert("2", "tank-01", TEMPLATE, facts_from(TEMPLATE), ["+15550000001"])
    a = agents.decide(2, "reject", "false alarm")
    assert a.status == "rejected" and len(sent) == 1


def test_reworded_alert_that_drops_a_number_falls_back_to_template():
    agents, _ = make()
    a = agents.alerts.setdefault("x", __import__("clarity_agent.agents", fromlist=["PendingAlert"]).PendingAlert("x", "tank-01", TEMPLATE, facts_from(TEMPLATE), []))
    assert agents._guard(a, "Water at the tank is bad, please be careful.") == scrub(TEMPLATE)


def test_below_threshold_sends_without_approval():
    agents, sent = make(threshold=3)
    a = agents.start_alert("7", "tank-01", TEMPLATE, facts_from(TEMPLATE), ["+15550000001"])
    assert a.status == "sent" and len(sent) == 1


def test_chat_fallback_without_gemini():
    agents, _ = make()
    agents.data.ingest({"type": "reading", "id": 1, "node": "tank-01", "name": "Princeton tank", "tds": 8, "ph": 7.0, "verdict": "SAFE", "sim": False, "clarity": 0.98})
    reply = agents.chat("+15550000001", "is my water safe?")
    assert "TDS 8" in reply and not violates(reply)
    assert "TDS (total dissolved solids)" in agents.chat("+1", "what's TDS?")
    assert "only help with your water" in agents.chat("+1", "who won the game last night")
    assert "Hi, I'm Clarity" in agents.chat("+1", "hey")


def test_non_water_photo_is_declined():
    v = PhotoVerdict(is_water=False, appearance="unclear", color="", confidence=0.9, note="a dog")
    assert "only check photos of your water" in reply_for(v, None, None)


def test_photo_reply_wording():
    v = PhotoVerdict(is_water=True, appearance="particles", color="light brown", confidence=0.8, note="specks visible")
    r = reply_for(v, "Princeton tank", {"tds": 780, "clarity": 0.83})
    assert "particles" in r and "780" in r and not violates(r)


def _fed_data():
    d = LiveData(gateway="http://127.0.0.1:9")
    d.ingest({"type": "reading", "node": "tank-01", "name": "Clarity tank", "phase": "before", "tds": 780, "ph": 7.2, "verdict": "HIGH_TDS", "sim": False})
    d.ingest({"type": "reading", "node": "tank-01", "name": "Clarity tank", "phase": "after", "tds": 8, "ph": 7.0, "verdict": "SAFE", "filter": "ZEROWATER", "sim": False})
    d.ingest({"type": "reading", "node": "tap-02", "name": "Nassau St tap", "phase": "before", "tds": 160, "ph": 5.9, "ph_est": False, "verdict": "PH_WARN", "sim": False})
    return d


def test_status_judges_raw_water_not_filtered():
    from clarity_agent.intents import answer
    out = answer("is my water ok?", _fed_data())
    assert "🚨 Clarity tank: TDS 780" in out and "filtered: TDS 8 ✓" in out


def test_filter_recommendation_uses_readings():
    from clarity_agent.intents import answer
    out = answer("what filter should I buy?", _fed_data())
    assert "ZeroWater" in out and "780" in out and "brought it to 8 ppm" in out and "pH is low" in out


def test_reworded_alert_must_keep_header_and_reply_line():
    agents, sent = make(threshold=99)
    tpl = "🚨 Water alert · Clarity\n\nTDS 780 ppm ⚠️ (limit 500)\n\nDon't drink it unfiltered.\nReply OK · INFO · STOP"
    a = agents.start_alert("9", "tank-01", tpl, facts_from(tpl), ["+1"])
    drifted = "🚨 Clarity Water Notice: tank-01\n\nTDS is 780 ppm ⚠️ (limit 500)\nReply OK · INFO · STOP"
    assert agents._guard(a, drifted) == tpl


def test_estimated_ph_offline_status_and_filter_advice(monkeypatch):
    from clarity_agent.intents import answer
    monkeypatch.setenv("PH_ESTIMATED", "1")
    data = LiveData(gateway="http://127.0.0.1:9")
    data.ingest({"type": "reading", "node": "tank-01", "name": "Clarity tank", "phase": "before",
                 "tds": 140, "ph": 5.1, "ph_est": True, "clarity": 0.95, "verdict": "PH_WARN", "sim": False})
    out = answer("status", data)
    assert "✅ Clarity tank" in out
    assert "pH 5.1 (estimated from TDS)" in out
    assert "🚨" not in out and "⚠️" not in out
    assert "pH is low" not in answer("what filter should I buy?", data)
    data.latest["tank-01"]["ph_est"] = False
    assert "🚨 Clarity tank" in answer("status", data)
    assert "pH is low" in answer("what filter should I buy?", data)


def test_estimated_ph_offline_legacy_default_and_independent_signals(monkeypatch):
    from clarity_agent.intents import _icon, ph_is_estimated
    r = {"ph": 5.1, "tds": 140, "clarity": 0.95, "verdict": "PH_WARN"}
    monkeypatch.setenv("PH_ESTIMATED", "1")
    assert ph_is_estimated(r) and _icon(r) == "✅"
    assert not ph_is_estimated({**r, "ph_est": 0})
    assert _icon({**r, "tds": 780, "ph_est": True}) == "🚨"
    assert _icon({**r, "clarity": 0.4, "ph_est": True}) == "⚠️"
    monkeypatch.setenv("PH_ESTIMATED", "0")
    assert not ph_is_estimated(r) and _icon(r) == "🚨"
    assert ph_is_estimated({**r, "ph_est": 1})


def test_reworded_alert_cannot_drop_estimated_ph_label():
    agents, _ = make()
    from clarity_agent.agents import PendingAlert
    tpl = "🚨 Water alert · Clarity\n\nTDS 780 ppm ⚠️ (limit 500)\npH 7.2 (estimated from TDS)\nReply OK · INFO · STOP"
    alert = PendingAlert("estimate", "tank-01", tpl, facts_from(tpl), [])
    changed = tpl.replace("pH 7.2 (estimated from TDS)", "pH 7.2 ✓")
    assert agents._guard(alert, changed) == tpl
