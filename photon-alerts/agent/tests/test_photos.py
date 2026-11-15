"""Photo replies for every kind of picture, with Gemini stubbed so it runs without a key."""
import os

os.environ.pop("GOOGLE_API_KEY", None)
os.environ.pop("GEMINI_API_KEY", None)
os.environ["EVIDENCE_FILE"] = "/tmp/clarity-test-photo-evidence.json"
os.environ["GATEWAY_HTTP"] = "http://127.0.0.1:9"
if os.path.exists(os.environ["EVIDENCE_FILE"]):
    os.remove(os.environ["EVIDENCE_FILE"])

import pytest
from fastapi.testclient import TestClient

from clarity_agent import server
from clarity_agent.photos import DECLINE, PhotoVerdict
from clarity_agent.safety import violates

client = TestClient(server.app)
server.data.ingest({"type": "reading", "node": "tank-01", "name": "Clarity tank", "phase": "before", "tds": 780, "ph": 7.2, "sim": False})
server.data.ingest({"type": "reading", "node": "tap-02", "name": "Nassau St tap", "phase": "before", "tds": 140, "ph": 7.4, "sim": False})


def V(**kw):
    base = dict(is_water=True, appearance="clear", color="colorless", confidence=0.9, note="")
    return PhotoVerdict(**{**base, **kw})


CASES = [
    # name, verdict, node, must contain, must not contain, attached as evidence
    ("murky glass", V(appearance="particles", color="light brown", note="Floating debris and sediment at the bottom."), "tank-01",
     ["Visible particles", "Don't drink it unfiltered", "TDS 780 ppm · pH 7.2 🚨"], ["✅"], True),
    ("brown tap water", V(appearance="discolored", color="dark brown", note="Water is brown."), "tap-02",
     ["Discolored (dark brown)", "Don't drink it unfiltered"], [], True),
    ("cloudy glass", V(appearance="cloudy", color="white haze"), None, ["Looks cloudy", "Don't drink it unfiltered"], ["Last sensor"], False),
    ("clear glass, failing site", V(note="Clear and colorless."), "tank-01", ["✅ Looks clear", "Clear water can still fail"], [], True),
    ("clear glass, normal site", V(), "tap-02", ["✅ Looks clear", "TDS 140"], ["Clear water can still fail", "unfiltered"], True),
    ("blurry/dark photo", V(appearance="clear", confidence=0.3), "tap-02", ["Hard to tell", "good light"], ["✅"], True),
    ("Gemini says safe", V(note="This water looks safe to drink."), "tap-02", ["within normal range"], [], True),
    ("city scene with rivers", V(is_water=False, appearance="unclear"), "tank-01", [DECLINE], ["Photo check"], False),
    ("selfie (Gemini errors)", None, "tank-01", [DECLINE], ["Photo check"], False),
]


@pytest.mark.parametrize("name,verdict,node,has,hasnt,attached", CASES, ids=[c[0] for c in CASES])
def test_photo_reply(monkeypatch, name, verdict, node, has, hasnt, attached):
    monkeypatch.setattr(server, "classify", lambda b64, mime: verdict)
    before = sum(len(v) for v in server.data.evidence.values())
    r = client.post("/photo", json={"phone": "+15550001111", "image_b64": "aGk=", "mime": "image/jpeg", "node": node, "text": ""})
    assert r.status_code == 200
    reply = r.json()["reply"]
    print(f"\n--- {name} ---\n{reply}")
    for s in has:
        assert s in reply, (s, reply)
    for s in hasnt:
        assert s not in reply, (s, reply)
    assert not violates(reply)
    assert len(reply) < 500  # fits on a phone screen
    after = sum(len(v) for v in server.data.evidence.values())
    assert (after - before == 1) == attached


def test_quota_error_says_try_later(monkeypatch):
    from clarity_agent import photos
    def boom(b64, mime):
        photos.LAST_ERROR = "GoogleRateLimitError: 429 RESOURCE_EXHAUSTED"
        return None
    monkeypatch.setattr(server, "classify", boom)
    r = client.post("/photo", json={"phone": "+1", "image_b64": "aGk=", "mime": "image/jpeg", "node": None, "text": ""}).json()
    assert "can't check it right now" in r["reply"]
