import unittest

from fastapi.testclient import TestClient

from app.main import app, health_summary_store
from app.models import SensorReading


class HealthSummaryValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        health_summary_store.clear()
        self.current_payload = {
            "timestamp": "2026-09-26T12:00:00Z",
            "source": "watch",
            "sensor_type": "steps",
            "value": 4321.0,
            "unit": "count",
            "is_simulated": False,
            "metadata": {
                "provider": "health_connect",
                "summary_kind": "current",
                "summary": "today",
                "raw_history_uploaded": False,
                "sample_count": 1,
            },
        }
        self.baseline_payload = {
            **self.current_payload,
            "value": 6543.2,
            "unit": "count/day",
            "metadata": {
                "provider": "health_connect",
                "summary_kind": "baseline",
                "summary": "30_day_daily_average",
                "raw_history_uploaded": False,
                "requested_days": 30,
                "days_with_data": 28,
                "minimum_daily_steps": 1200.0,
                "maximum_daily_steps": 11200.0,
                "standard_deviation": 2100.0,
            },
        }

    def test_model_accepts_compact_current_and_baseline_summaries(self) -> None:
        current = SensorReading.model_validate(self.current_payload)
        baseline = SensorReading.model_validate(self.baseline_payload)

        self.assertEqual(current.metadata["summary_kind"], "current")
        self.assertEqual(baseline.metadata["summary_kind"], "baseline")
        self.assertFalse(baseline.metadata["raw_history_uploaded"])

    def test_ingestion_acknowledges_without_returning_health_values(self) -> None:
        client = TestClient(app)
        response = client.post("/api/sensors/readings", json=self.baseline_payload)

        self.assertEqual(response.status_code, 202)
        body = response.json()
        self.assertFalse(body["stored"])
        self.assertTrue(body["compact_summary_cached"])
        self.assertNotIn("value", body)
        self.assertNotIn("metadata", body)

    def test_current_and_baseline_are_kept_in_separate_latest_only_slots(self) -> None:
        client = TestClient(app)
        newer_current = {**self.current_payload, "value": 5000.0}

        self.assertEqual(client.post("/api/sensors/readings", json=self.current_payload).status_code, 202)
        self.assertEqual(client.post("/api/sensors/readings", json=self.baseline_payload).status_code, 202)
        self.assertEqual(client.post("/api/sensors/readings", json=newer_current).status_code, 202)

        response = client.get("/api/sensors/health-connect/summaries")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store, private")
        summaries = response.json()["summaries"]
        self.assertEqual(len(summaries), 2)
        current = next(item for item in summaries if item["metadata"]["summary_kind"] == "current")
        baseline = next(item for item in summaries if item["metadata"]["summary_kind"] == "baseline")
        self.assertEqual(current["value"], 5000.0)
        self.assertEqual(baseline["value"], 6543.2)

    def test_raw_history_container_is_rejected_and_never_exposed(self) -> None:
        client = TestClient(app)
        payload = {
            **self.baseline_payload,
            "metadata": {
                **self.baseline_payload["metadata"],
                "daily_values": [1000, 2000, 3000],
            },
        }

        response = client.post("/api/sensors/readings", json=payload)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(client.get("/api/sensors/health-connect/summaries").json()["summaries"], [])


if __name__ == "__main__":
    unittest.main()
