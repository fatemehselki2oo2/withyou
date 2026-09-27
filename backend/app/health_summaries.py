from __future__ import annotations

from datetime import datetime
from typing import Any

from .models import SensorReading


HEALTH_SENSOR_TYPES = {"steps", "sleep", "heart_rate"}
SUMMARY_KINDS = {"current", "baseline"}

# Only compact scalar metadata needed to explain a summary is retained. Unknown
# fields are ignored, and containers are rejected so raw history cannot be
# smuggled into this small in-memory cache.
ALLOWED_METADATA_KEYS = {
    "provider",
    "summary_kind",
    "summary",
    "window_start",
    "window_end",
    "is_health_connect_summary",
    "raw_history_uploaded",
    "origin_scope",
    "requested_days",
    "days_with_data",
    "minimum_daily_steps",
    "maximum_daily_steps",
    "standard_deviation",
    "sleep_start",
    "wake_time",
    "merged_parent_record_count",
    "selection_rule",
    "completed_session_count",
    "minimum_hours",
    "maximum_hours",
    "sample_count",
    "minimum_bpm",
    "maximum_bpm",
}


class HealthSummaryStore:
    """Keeps at most one current and one baseline summary per health metric."""

    def __init__(self) -> None:
        self._summaries: dict[tuple[str, str], dict[str, Any]] = {}

    def clear(self) -> None:
        self._summaries.clear()

    def ingest(self, reading: SensorReading, received_at: datetime) -> bool:
        if reading.source != "watch" or reading.sensor_type not in HEALTH_SENSOR_TYPES:
            return False
        if reading.metadata.get("provider") != "health_connect":
            return False

        summary_kind = reading.metadata.get("summary_kind")
        raw_history_uploaded = reading.metadata.get("raw_history_uploaded")
        # Older bridge summaries remain accepted by the ingestion endpoint, but
        # only the new explicit, privacy-labelled summaries enter this cache.
        if summary_kind not in SUMMARY_KINDS or raw_history_uploaded is not False:
            return False

        if any(isinstance(value, (dict, list, tuple, set)) for value in reading.metadata.values()):
            raise ValueError("Health Connect summaries may contain compact scalar metadata only.")

        metadata = {
            key: value
            for key, value in reading.metadata.items()
            if key in ALLOWED_METADATA_KEYS
        }
        normalized = reading.model_copy(update={"metadata": metadata})
        self._summaries[(reading.sensor_type, summary_kind)] = {
            "reading": normalized,
            "received_at": received_at,
        }
        return True

    def latest(self) -> dict[str, Any]:
        entries = sorted(
            self._summaries.values(),
            key=lambda entry: (
                entry["reading"].sensor_type,
                entry["reading"].metadata["summary_kind"],
            ),
        )
        updated_at = max(
            (entry["received_at"] for entry in entries),
            default=None,
        )
        return {
            "updated_at": updated_at.isoformat() if updated_at else None,
            "summaries": [
                entry["reading"].model_dump(mode="json")
                for entry in entries
            ],
        }
