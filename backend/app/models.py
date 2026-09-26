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
]


class SensorReading(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str | int | None = None
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

    @field_validator("value")
    @classmethod
    def value_must_be_finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("value must be finite")
        return value

    @model_validator(mode="after")
    def validate_sensor_range_and_metadata(self) -> SensorReading:
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
    environment: EnvironmentContext | None = None
    mood: str | None = Field(default=None, max_length=200)
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
