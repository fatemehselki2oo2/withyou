from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from .models import SensorReading


DEMO_SESSION_PATTERN = re.compile(r"^[A-Z0-9]{6,12}$")
HOME_SENSOR_TYPES = {"temperature", "humidity", "light", "motion", "proximity"}


class DemoSessionDeviceConflict(Exception):
    """Raised when a code that is already paired is reused by another device."""


class DemoSessionStore:
    """Temporary, in-memory transport for the Pico W judging demo.

    Each code is bound to the first device that sends it. Only the newest
    reading for each home-sensor type is retained; there is no raw history and
    no endpoint that lists session codes.
    """

    def __init__(self, ttl_minutes: int) -> None:
        self._ttl = timedelta(minutes=ttl_minutes)
        self._sessions: dict[str, dict[str, Any]] = {}

    @staticmethod
    def normalize_code(value: str) -> str:
        code = value.strip().upper()
        if not DEMO_SESSION_PATTERN.fullmatch(code):
            raise ValueError("Demo code must be 6-12 letters or numbers.")
        return code

    def _cleanup(self, now: datetime) -> None:
        expired = [
            code for code, session in self._sessions.items()
            if session["expires_at"] <= now
        ]
        for code in expired:
            del self._sessions[code]

    def ingest(self, reading: SensorReading, received_at: datetime) -> tuple[SensorReading, bool]:
        """Cache a latest-only summary and return (normalized_reading, was_new)."""
        if not reading.demo_session_id:
            return reading, False
        if reading.sensor_type not in HOME_SENSOR_TYPES:
            raise ValueError("Demo sessions accept only home-environment sensor types.")

        self._cleanup(received_at)
        code = self.normalize_code(reading.demo_session_id)
        device_id = reading.device_id or ""
        session = self._sessions.get(code)
        if session is None:
            session = {
                "demo_session_id": code,
                "device_id": device_id,
                "created_at": received_at,
                "updated_at": None,
                "expires_at": received_at + self._ttl,
                "readings": {},
            }
            self._sessions[code] = session
        elif session["device_id"] != device_id:
            raise DemoSessionDeviceConflict

        current = session["readings"].get(reading.sensor_type)
        if current and reading.id is not None and current.id == reading.id:
            return current, False

        reading_id = reading.id or f"{code}:{device_id}:{reading.sensor_type}:{uuid.uuid4().hex}"
        normalized = reading.model_copy(update={
            "id": reading_id,
            "demo_session_id": code,
            "device_id": device_id,
            "metadata": {
                **reading.metadata,
                "demo_session_id": code,
                "device_id": device_id,
            },
        })
        session["readings"][reading.sensor_type] = normalized
        session["updated_at"] = received_at
        session["expires_at"] = received_at + self._ttl
        return normalized, True

    def latest(self, demo_session_id: str, now: datetime | None = None) -> dict[str, Any] | None:
        current_time = now or datetime.now(UTC)
        self._cleanup(current_time)
        code = self.normalize_code(demo_session_id)
        session = self._sessions.get(code)
        if session is None:
            return None

        return {
            "demo_session_id": code,
            "device_id": session["device_id"],
            "updated_at": session["updated_at"].isoformat() if session["updated_at"] else None,
            "expires_at": session["expires_at"].isoformat(),
            "readings": [
                reading.model_dump(mode="json")
                for reading in session["readings"].values()
            ],
        }
