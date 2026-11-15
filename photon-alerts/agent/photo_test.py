"""Send every photo in test-photos/ to the running agent and show what Clarity would text back.

Run with the agent up (npm run agent):  npm run photo-test
Files named *NOT-water* should get the "I can only check photos of your water" reply; the rest should get a Photo check.
"""
import base64
import mimetypes
import os
import sys
from pathlib import Path

import httpx

AGENT = os.environ.get("AGENT_URL", "http://localhost:8001")
folder = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "test-photos")

health = httpx.get(f"{AGENT}/health", timeout=5).json()
print(f"agent up · gemini={'on' if health.get('gemini') else 'OFF (every photo will be declined)'}\n")
passed = failed = 0
for f in sorted(folder.iterdir()):
    mime = mimetypes.guess_type(f.name)[0] or ""
    if not mime.startswith("image/"):
        continue
    body = {"phone": "+10000000000", "image_b64": base64.b64encode(f.read_bytes()).decode(), "mime": mime, "node": None, "text": ""}  # no node, so test photos never become evidence
    res = httpx.post(f"{AGENT}/photo", json=body, timeout=120).json()
    reply = res["reply"]
    c = res.get("classification")
    if res.get("error") and "RESOURCE_EXHAUSTED" in res["error"]:
        print(f"SKIP {f.name}  [Gemini out of quota]\n")
        continue
    declined = reply.startswith("📷 I can only check photos")
    ok = declined == ("NOT-water" in f.name) and " safe" not in reply.lower().replace("unsafe", "")
    passed, failed = passed + ok, failed + (not ok)
    why = f"GEMINI ERROR: {res.get('error')}" if not c else f"is_water={c['is_water']} {c['appearance']} conf={c['confidence']}"
    print(f"{'PASS' if ok else 'FAIL'} {f.name}  [{why}]\n" + "\n".join("   " + line for line in reply.splitlines()) + "\n")
print(f"{passed} passed, {failed} failed")
