from __future__ import annotations

import json
import os
import time
from collections import defaultdict, deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_ROOT.parent
load_dotenv(PROJECT_ROOT / ".env", override=False)
load_dotenv(PROJECT_ROOT.parent / ".env", override=False)

from .companion import create_companion_response, process_voice_message
from .demo_sessions import DemoSessionDeviceConflict, DemoSessionStore
from .models import (
    CompanionRequest,
    CompanionResponse,
    SensorReading,
    VoiceCompanionResponse,
    WellnessContext,
)


MAX_JSON_BYTES = 32_768
MAX_REQUEST_BYTES = int(os.environ.get("MAX_REQUEST_BYTES", 12 * 1024 * 1024))
MAX_AUDIO_BYTES = int(os.environ.get("MAX_AUDIO_BYTES", 10 * 1024 * 1024))
RATE_LIMIT_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PER_MINUTE", 30))
DEMO_SESSION_TTL_MINUTES = int(os.environ.get("DEMO_SESSION_TTL_MINUTES", 240))

app = FastAPI(
    title="WithYou API",
    description="Privacy-aware sensor ingestion and companion backend for WithYou.",
    version="0.2.0",
)

origins = [
    origin.strip()
    for origin in os.environ.get(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Demo-Session-ID"],
)

sensor_state: dict[str, Any] = {
    "received_count": 0,
    "last_reading_at": None,
    "last_source": None,
    "last_sensor_type": None,
    # This is connection metadata only. Health values are acknowledged and discarded.
    "sources": {
        "arduino": {"connected": False, "last_reading_at": None, "last_sensor_type": None},
        "watch": {"connected": False, "last_reading_at": None, "last_sensor_type": None},
    },
}
request_windows: dict[str, deque[float]] = defaultdict(deque)
demo_session_store = DemoSessionStore(ttl_minutes=DEMO_SESSION_TTL_MINUTES)


@app.middleware("http")
async def security_limits(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BYTES:
                return JSONResponse(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    content={"detail": "Request body is too large."},
                )
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length header."})

    if request.url.path.startswith("/api/companion"):
        client_key = request.client.host if request.client else "unknown"
        now = time.monotonic()
        window = request_windows[client_key]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= RATE_LIMIT_PER_MINUTE:
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={"detail": "Too many companion requests. Please wait a moment."},
            )
        window.append(now)

    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/sensors/health")
async def sensors_health() -> dict[str, Any]:
    return {
        "status": "ok",
        "accepting_readings": True,
        "supported_sources": ["phone", "arduino", "watch", "manual"],
        "supported_sensor_types": [
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
        ],
        **sensor_state,
    }


@app.post("/api/sensors/readings", status_code=status.HTTP_202_ACCEPTED)
async def ingest_sensor_reading(reading: SensorReading, request: Request) -> dict[str, Any]:
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_JSON_BYTES:
        raise HTTPException(status_code=413, detail="Sensor payload must be 32 KB or smaller.")

    received_at = datetime.now(UTC)
    temporarily_cached = False
    try:
        reading, temporarily_cached = demo_session_store.ingest(reading, received_at)
    except DemoSessionDeviceConflict:
        raise HTTPException(status_code=409, detail="Demo code is already paired with another device.") from None
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None

    sensor_state["received_count"] += 1
    sensor_state["last_reading_at"] = received_at.isoformat()
    sensor_state["last_source"] = reading.source
    sensor_state["last_sensor_type"] = reading.sensor_type
    if reading.source in sensor_state["sources"]:
        sensor_state["sources"][reading.source] = {
            "connected": True,
            "last_reading_at": sensor_state["last_reading_at"],
            "last_sensor_type": reading.sensor_type,
        }
    return {
        "status": "accepted",
        "received_at": sensor_state["last_reading_at"],
        "source": reading.source,
        "sensor_type": reading.sensor_type,
        "stored": False,
        "temporarily_cached": temporarily_cached,
        "reading_id": reading.id,
    }


@app.get("/api/sensors/demo-sessions/latest")
async def latest_demo_session_readings(
    response: Response,
    demo_session_id: str = Header(alias="X-Demo-Session-ID"),
) -> dict[str, Any]:
    """Return only the latest summaries for the exact requested demo code."""
    response.headers["Cache-Control"] = "no-store, private"
    try:
        session = demo_session_store.latest(demo_session_id)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    if session is None:
        # The same response covers unknown and expired codes to avoid revealing
        # whether another judging session ever existed.
        raise HTTPException(status_code=404, detail="Demo session not found or expired.")
    return {"status": "ok", **session}


@app.post("/api/companion/respond", response_model=CompanionResponse)
async def companion_respond(payload: CompanionRequest) -> CompanionResponse:
    return await create_companion_response(payload.wellness_context, payload.user_message)


@app.post("/api/companion/voice", response_model=VoiceCompanionResponse)
async def companion_voice(
    audio: UploadFile = File(...),
    wellness_context: str = Form(..., max_length=20_000),
) -> VoiceCompanionResponse:
    base_content_type = (audio.content_type or "").split(";", 1)[0].lower()
    allowed_types = {
        "audio/webm",
        "audio/wav",
        "audio/x-wav",
        "audio/mpeg",
        "audio/mp4",
        "audio/ogg",
        "audio/m4a",
    }
    if base_content_type not in allowed_types:
        raise HTTPException(status_code=415, detail="Unsupported audio format.")

    try:
        context = WellnessContext.model_validate(json.loads(wellness_context))
    except (json.JSONDecodeError, ValidationError):
        raise HTTPException(status_code=422, detail="Invalid summarized wellness context.") from None

    audio_bytes = await audio.read(MAX_AUDIO_BYTES + 1)
    await audio.close()
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio upload must be 10 MB or smaller.")
    if not audio_bytes:
        raise HTTPException(status_code=422, detail="Audio recording is empty.")

    return await process_voice_message(
        audio_bytes=audio_bytes,
        filename=audio.filename,
        content_type=base_content_type,
        context=context,
    )

