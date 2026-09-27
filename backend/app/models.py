from __future__ import annotations

import json
import math
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


SensorSource = Literal["phone", "arduino", "watch", "manual"]
SensorType = Literal[
    "activity",
    "motion",
    "sound_level",
    "temperature",
    "humidity",
    "light",
    "sleep",
    "mood",
    "proximity",
    "steps",
    "heart_rate",
]


class SensorReading(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str | int | None = None
    demo_session_id: str | None = Field(default=None, min_length=6, max_length=12, pattern=r"^[A-Z0-9]+$")
    device_id: str | None = Field(default=None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    timestamp: datetime
    source: SensorSource
    sensor_type: SensorType
    value: float
    unit: str = Field(min_length=1, max_length=32)
    confidence: float | None = Field(default=None, ge=0, le=1)
    is_simulated: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("timestamp")
    @classmethod
    def timestamp_must_include_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamp must include a timezone")
        return value

    @field_validator("demo_session_id", mode="before")
    @classmethod
    def normalize_demo_session_id(cls, value: Any) -> Any:
        return value.strip().upper() if isinstance(value, str) else value

    @field_validator("value")
    @classmethod
    def value_must_be_finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("value must be finite")
        return value

    @model_validator(mode="after")
    def validate_sensor_range_and_metadata(self) -> SensorReading:
        if self.demo_session_id and self.source != "arduino":
            raise ValueError("demo_session_id is only supported for Arduino/Pico readings")
        if self.demo_session_id and not self.device_id:
            raise ValueError("device_id is required when demo_session_id is provided")
        ranges: dict[str, tuple[float, float]] = {
            "activity": (0, 1),
            "motion": (0, 1),
            "sound_level": (0, 1),
            "temperature": (-100, 200),
            "humidity": (0, 100),
            "light": (0, 200_000),
            "sleep": (0, 24),
            "mood": (0, 1),
            "proximity": (0, 100_000),
            "steps": (0, 200_000),
            "heart_rate": (1, 300),
        }
        minimum, maximum = ranges[self.sensor_type]
        if not minimum <= self.value <= maximum:
            raise ValueError(f"{self.sensor_type} value must be between {minimum} and {maximum}")
        if len(json.dumps(self.metadata, default=str).encode("utf-8")) > 4096:
            raise ValueError("metadata must be 4 KB or smaller")
        return self


class ActivityContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current: float = Field(ge=0, le=1)
    baseline: float = Field(ge=0, le=1)
    difference_percent: float = Field(ge=-100, le=1000)
    status: Literal["normal", "changed"]


class SleepContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hours: float = Field(ge=0, le=24)
    baseline_hours: float = Field(ge=0, le=24)
    status: Literal["normal", "changed"]


class MetricComparisonContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current: float = Field(ge=0, le=200_000)
    baseline: float = Field(gt=0, le=200_000)
    difference_percent: float = Field(ge=-100, le=10_000)
    status: Literal["normal", "changed"]


EvidenceSource = Literal["phone_motion", "watch_steps", "home_sensor"]


class ActivityFusionContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    interpretation: Literal["normal", "changed", "mixed", "unavailable"]
    confidence: Literal["none", "low", "normal", "high"]
    supporting_sources: list[EvidenceSource] = Field(default_factory=list, max_length=2)
    missing_sources: list[EvidenceSource] = Field(default_factory=list, max_length=2)
    note: str = Field(max_length=240)


class DataQualificationContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confidence: Literal["low", "medium", "high"]
    qualified_for_baseline: bool
    supporting_sources: list[str] = Field(default_factory=list, max_length=4)
    conflicting_sources: list[str] = Field(default_factory=list, max_length=4)
    reason: str = Field(max_length=300)


class EnvironmentContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    temperature: float | None = Field(default=None, ge=-100, le=200)
    temperature_source: Literal["simulated", "arduino", "unknown"] | None = None
    humidity: float | None = Field(default=None, ge=0, le=100)
    light: float | None = Field(default=None, ge=0, le=200_000)
    sound_level: Literal["quiet", "normal", "loud", "unknown"] = "unknown"


class WellnessContext(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    activity: ActivityContext | None = None
    sleep: SleepContext | None = None
    steps: MetricComparisonContext | None = None
    heart_rate: MetricComparisonContext | None = None
    environment: EnvironmentContext | None = None
    mood: str | None = Field(default=None, max_length=200)
    activity_fusion: ActivityFusionContext | None = None
    supporting_sources: list[EvidenceSource] = Field(default_factory=list, max_length=3)
    missing_sources: list[EvidenceSource] = Field(default_factory=list, max_length=3)
    baseline_state: Literal["learning", "qualified", "adapting"] = "learning"
    baseline_states: dict[str, Literal["learning", "qualified", "adapting"]] = Field(default_factory=dict)
    data_confidence: dict[str, DataQualificationContext] = Field(default_factory=dict)
    overall_pattern_status: Literal["normal", "changed"]
    severity: Literal["low", "moderate"]
    reasons: list[str] = Field(default_factory=list, max_length=8)
    check_in_recommended: bool

    @field_validator("reasons")
    @classmethod
    def limit_reason_lengths(cls, reasons: list[str]) -> list[str]:
        if any(len(reason) > 180 for reason in reasons):
            raise ValueError("each reason must be 180 characters or fewer")
        return reasons


class CompanionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    wellness_context: WellnessContext
    user_message: str = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def context_must_be_small(self) -> CompanionRequest:
        if len(self.wellness_context.model_dump_json().encode("utf-8")) > 20_000:
            raise ValueError("wellness_context must be 20 KB or smaller")
        return self


class CompanionResponse(BaseModel):
    text: str
    observations_used: list[str]
    used_ai: bool


class VoiceCompanionResponse(CompanionResponse):
    transcript: str
    audio_base64: str | None = None
    audio_mime_type: str | None = None
    audio_available: bool = False
