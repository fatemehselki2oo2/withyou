import unittest

from app.companion import local_fallback
from app.models import WellnessContext


class SensorFusionContextTests(unittest.TestCase):
    def test_mixed_activity_evidence_is_accepted_without_a_changed_pattern(self) -> None:
        context = WellnessContext.model_validate({
            "activity": {
                "current": 0.2,
                "baseline": 0.65,
                "difference_percent": -69.2,
                "status": "changed",
            },
            "steps": {
                "current": 10000,
                "baseline": 10000,
                "difference_percent": 0,
                "status": "normal",
            },
            "sleep": None,
            "heart_rate": None,
            "environment": None,
            "mood": None,
            "activity_fusion": {
                "interpretation": "mixed",
                "confidence": "low",
                "supporting_sources": ["phone_motion", "watch_steps"],
                "missing_sources": [],
                "note": "Sources do not point in the same direction.",
            },
            "supporting_sources": ["phone_motion", "watch_steps"],
            "missing_sources": ["home_sensor"],
            "overall_pattern_status": "normal",
            "severity": "low",
            "reasons": [],
            "check_in_recommended": False,
        })

        self.assertEqual(context.activity_fusion.interpretation, "mixed")
        self.assertEqual(context.supporting_sources, ["phone_motion", "watch_steps"])

    def test_learning_baseline_uses_uncertain_companion_language(self) -> None:
        context = WellnessContext.model_validate({
            "activity": None,
            "sleep": None,
            "steps": None,
            "heart_rate": None,
            "environment": None,
            "mood": None,
            "activity_fusion": None,
            "supporting_sources": [],
            "missing_sources": ["phone_motion", "watch_steps", "home_sensor"],
            "baseline_state": "learning",
            "overall_pattern_status": "normal",
            "severity": "low",
            "reasons": [],
            "check_in_recommended": False,
        })

        response = local_fallback(context, "hello")
        self.assertIn("still learning your normal routine", response.text)


if __name__ == "__main__":
    unittest.main()
