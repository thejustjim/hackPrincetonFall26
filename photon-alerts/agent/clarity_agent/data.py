"""Live data the agent reads: gateway REST endpoints plus /ws frames forwarded by the Photon bridge."""
from __future__ import annotations

import json
import os
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

import httpx

GATEWAY = os.environ.get("GATEWAY_HTTP", "http://localhost:8000")
EVIDENCE_FILE = Path(os.environ.get("EVIDENCE_FILE", "evidence.json"))


class LiveData:
    def __init__(self, gateway: str = GATEWAY, client: httpx.Client | None = None):
        self.gateway = gateway.rstrip("/")
        self.http = client or httpx.Client(timeout=5)
        self.latest: dict[str, dict] = {}          # node -> latest raw tap reading (from /ws)
        self.filtered: dict[str, dict] = {}        # node -> latest after-filter reading
        self.decisions: dict[int, dict] = {}       # reading id -> decision
        self.reports: dict[str, deque] = defaultdict(lambda: deque(maxlen=5))  # node -> investigator reports
        self.evidence: dict[str, list] = json.loads(EVIDENCE_FILE.read_text()) if EVIDENCE_FILE.exists() else {}

    # --- frames from /ws (forwarded by the bridge) ---
    def ingest(self, frame: dict) -> None:
        t = frame.get("type")
        if t == "reading":
            if frame.get("phase") == "after":
                self.filtered[frame["node"]] = frame
            else:
                self.latest[frame["node"]] = frame
                self.filtered.pop(frame["node"], None)
        elif t == "decision":
            self.decisions[frame["id"]] = frame
        elif t == "report":
            self.reports[frame["node"]].append(frame)

    # --- REST, falling back to what /ws has shown us if the gateway is unreachable ---
    def _get(self, path: str, **params) -> Any:
        try:
            r = self.http.get(f"{self.gateway}{path}", params={k: v for k, v in params.items() if v is not None})
            r.raise_for_status()
            return r.json()
        except (httpx.HTTPError, ValueError):
            return None

    def nodes(self) -> list[dict]:
        got = self._get("/api/nodes")
        if got is not None:
            return got
        return [{"node": n, "name": r.get("name"), "sim": r.get("sim"), "latest": r} for n, r in self.latest.items()]

    def readings(self, node: str, limit: int = 10) -> list[dict]:
        got = self._get("/api/readings", node=node, limit=limit)
        if got is not None:
            return got
        # /ws only: the filtered retest (if any) is newer than the raw reading, since a raw one clears it.
        return [r for r in (self.filtered.get(node), self.latest.get(node)) if r]

    def sites(self) -> list[dict]:
        """Real (non-sim) sites: newest raw tap reading, plus the filtered retest if it came after it."""
        out = []
        for n in self.nodes():
            if n.get("sim"):
                continue
            node = n["node"]
            rows = self.readings(node, 10)  # newest first
            raw_i = next((i for i, r in enumerate(rows) if r.get("phase") != "after"), None)
            if raw_i is not None:
                raw = rows[raw_i]
                after = next((r for r in rows[:raw_i] if r.get("phase") == "after"), None)
            else:
                raw, after = self.latest.get(node), self.filtered.get(node)
            if raw:
                out.append({"node": node, "name": n.get("name") or raw.get("name") or node, "raw": raw, "filtered": after})
        return out

    def filters(self) -> list[dict]:
        return self._get("/api/filters") or []

    def node_reports(self, node: str) -> list[dict]:
        return list(self.reports.get(node, []))

    def attach_evidence(self, node: str, item: dict) -> None:
        item = {**item, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        self.evidence.setdefault(node, []).append(item)
        EVIDENCE_FILE.write_text(json.dumps(self.evidence, indent=2))
        # Let the gateway store it too if Jim adds the endpoint; ignore if it doesn't exist yet.
        try:
            self.http.post(f"{self.gateway}/api/evidence", json={"node": node, **item})
        except httpx.HTTPError:
            pass
