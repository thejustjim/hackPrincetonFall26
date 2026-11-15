"""Read-only network and placement API checks. Temp SQLite, no keys/cloud/hardware/lifespan.
Run: gateway/.venv/bin/python gateway/test_network_api.py
"""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

TEMP = tempfile.TemporaryDirectory(prefix="clarity-network-api-")
os.environ.update({"DB_PATH": str(Path(TEMP.name) / "api.db"), "MOCK": "1", "SIM_NODES": "0",
                   "GOOGLE_API_KEY": "", "GEMINI_API_KEY": "", "ANTHROPIC_API_KEY": "", "AI_PROVIDER": "",
                   "TIGER_DATABASE_URL": "", "DATABASE_URL": "", "INVESTIGATOR": "0", "SIM_FAULT_RATE": "0"})

from fastapi.testclient import TestClient
import gateway as G
import placement


class NetworkApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(G.app)  # no context manager: don't start radio/cloud background services
        self.assertIsNone(G.device)
        self.assertFalse(G.cloud_sync.enabled)
        self.before = G.db.total_changes

    def tearDown(self):
        self.assertEqual(G.db.total_changes, self.before)
        self.assertIsNone(G.device)
        self.assertIsNone(G.cloud_sync._thread)
        self.client.close()

    def test_network_exposes_explicit_simulated_stress_cases(self):
        with patch.object(G, "send_to_tank", side_effect=AssertionError("read-only route sent a command")):
            r = self.client.get("/api/network")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIs(data["simulated"], True)
        self.assertGreaterEqual(len(data["scenarios"]), 7)
        self.assertTrue(any(s.get("stress") for s in data["scenarios"]))

    def test_placement_has_full_denominators_and_all_budgets(self):
        with patch.object(Path, "write_text", side_effect=AssertionError("GET wrote a fixture")):
            r = self.client.get("/api/network/placement?budget=12")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIs(data["simulated"], True)
        self.assertEqual([b["budget"] for b in data["budgets"]], [4, 8, 12, 16, 20])
        self.assertEqual(data["model"]["event_count"], 117)
        self.assertEqual(data["selected_budget"], 12)
        self.assertEqual(data["selected"]["budget"], 12)
        self.assertEqual(len(data["selected"]["sensors"]), 12)
        self.assertEqual(data["selected"]["metrics"]["events"], 117)

    def test_budget_selection_never_mutates_cached_algorithm_payload(self):
        raw = placement.payload()
        self.assertNotIn("selected_budget", raw)
        self.assertNotIn("selected", raw)
        for budget in (4, 20, 8):
            r = self.client.get(f"/api/network/placement?budget={budget}")
            self.assertEqual(r.json()["selected"]["budget"], budget)
        self.assertNotIn("selected_budget", raw)
        self.assertNotIn("selected", raw)

    def test_unsupported_or_non_integer_budget_fails_closed(self):
        for value in ("0", "7", "21", "-1", "500", "12.5", "true"):
            self.assertEqual(self.client.get(f"/api/network/placement?budget={value}").status_code, 422, value)

    def test_prepared_fixture_is_read_only_fallback(self):
        with patch.object(placement, "payload", side_effect=OSError("module input unavailable")), \
             patch.object(Path, "write_text", side_effect=AssertionError("GET wrote a fixture")):
            r = self.client.get("/api/network/placement?budget=16")
        self.assertEqual(r.status_code, 200)
        self.assertIs(r.json()["simulated"], True)
        self.assertEqual(r.json()["selected"]["budget"], 16)

    def test_mock_health_names_scenario_without_claiming_live_measurement(self):
        with patch.dict(os.environ, {"MOCK_SCENARIO": "drift", "MOCK_SEED": "42"}):
            data = self.client.get("/health").json()
        self.assertIs(data["mock"], True)
        self.assertEqual(data["simulation"], {"scenario": "drift", "seed": 42, "background_fault_rate": 0.0})
        self.assertIs(data["cloud"]["enabled"], False)
        with patch.object(G, "MOCK", False):
            self.assertNotIn("simulation", self.client.get("/health").json())


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        G.db.close()
        TEMP.cleanup()
