# WithYou

WithYou is a privacy-aware wellness companion for people who live alone. It combines local phone sensing, voluntary check-ins, explainable pattern detection, and a warm AI companion without diagnosing physical or mental-health conditions.

## What the prototype does

- Summarizes real `DeviceMotionEvent` samples into three-second activity windows.
- Measures environmental sound amplitude locally for four seconds after an explicit tap. It does not save or transcribe environmental audio.
- Stores normalized activity, sound, sleep, mood, and environment readings in IndexedDB.
- Accepts manual sleep start/wake times and calculates duration.
- Accepts voluntary mood check-ins; mood is never inferred from a microphone.
- Combines signals with a local, explainable `PatternAnalyzer`.
- Sends only a compact `WellnessContext` and the user's message to the FastAPI companion endpoint.
- Supports typed companion messages and explicit, push-to-record voice turns.
- Accepts normalized Arduino/ESP32 readings without permanently storing them server-side.
- Provides reliable, labeled demo scenarios for judging.

WithYou notices changes in patterns. It does not diagnose conditions.

## Architecture

```text
Phone / Arduino / future Watch / Manual Check-In
                    ↓
          Normalized SensorReading
                    ↓
             Local IndexedDB
                    ↓
          Local PatternAnalyzer
                    ↓
       Summarized WellnessContext
                    ↓
                 FastAPI
                    ↓
     OpenAI Responses / Audio APIs
                    ↓
         Text and optional speech
```

Personal history remains in IndexedDB whenever possible. The backend receives individual external-device readings for acknowledgement and compact companion context—not the user's full local history.

## Normalized sensor model

Every local or external input uses this shape:

```json
{
  "timestamp": "2026-09-25T18:30:00Z",
  "source": "arduino",
  "sensor_type": "temperature",
  "value": 74.2,
  "unit": "fahrenheit",
  "confidence": 0.98,
  "is_simulated": false,
  "metadata": {
    "device_id": "withyou-room-01"
  }
}
```

Supported sources are `phone`, `arduino`, `watch`, and `manual`. Supported types are `activity`, `motion`, `sound_level`, `temperature`, `humidity`, `light`, `sleep`, `mood`, and `proximity`.

Complete ESP32 examples are in [`backend/examples/esp32-readings.json`](backend/examples/esp32-readings.json).

## Demo baseline and pattern rules

- Activity baseline: `0.65`; changed when activity is more than 35% lower.
- Sleep baseline: `7.5` hours; changed when sleep is more than two hours shorter.
- Wake baseline: `8:30 AM`; changed when wake time is more than two hours later.
- Mood is considered only when volunteered by the user.
- Sound and environment readings are supporting context, not evidence of illness.
- Multiple primary changes produce a moderate, non-medical pattern and recommend a check-in.

## OpenAI implementation

The backend follows current official OpenAI guidance:

- Python SDK and Responses API for companion text
- `gpt-transcribe` for completed, user-initiated voice recordings
- `gpt-4o-mini-tts` for optional spoken responses

The API key is loaded only by the backend. Voice audio is held in memory during a request and is not retained by WithYou after processing. The UI identifies spoken playback as AI-generated.

## Backend endpoints

- `GET /health` — basic application health
- `GET /api/sensors/health` — sensor ingestion status and last external source
- `POST /api/sensors/readings` — validated, stateless external reading acknowledgement
- `POST /api/companion/respond` — summarized context plus typed message
- `POST /api/companion/voice` — bounded temporary audio upload plus summarized context

Sensor payloads are limited to 32 KB. Audio defaults to a 10 MB limit. Companion routes use a lightweight in-memory per-IP rate limit suitable for a single-process prototype; use a shared store such as Redis before scaling to multiple server processes.

## Environment variables

Copy `.env.example` to `.env` for a project-local configuration, or provide equivalent Windows environment variables.

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Backend-only OpenAI credential | required for AI |
| `OPENAI_TEXT_MODEL` | Responses API model | `gpt-6-luna` |
| `OPENAI_TRANSCRIPTION_MODEL` | Voice transcription model | `gpt-transcribe` |
| `OPENAI_TTS_MODEL` | Speech generation model | `gpt-4o-mini-tts` |
| `OPENAI_TTS_VOICE` | Built-in TTS voice | `coral` |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins | local Vite origins |
| `MAX_AUDIO_BYTES` | Maximum temporary voice upload | `10485760` |
| `RATE_LIMIT_PER_MINUTE` | Companion requests per IP | `30` |
| `VITE_API_BASE_URL` | Frontend API URL, set in `frontend/.env` | `http://127.0.0.1:8000` |

The backend also detects the existing ignored workspace `.env`. Secrets are never bundled into the frontend.

## Run locally with PowerShell

### Backend

```powershell
cd "C:\Users\fatem\Documents\ChatGPT\HackGT\withyou\backend"

# First setup or dependency update
& "C:\Users\fatem\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m venv .venv
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt

# Run
& ".\.venv\Scripts\python.exe" -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Verify `http://localhost:8000/health` and `http://localhost:8000/api/sensors/health`.

### Frontend

In another PowerShell window:

```powershell
cd "C:\Users\fatem\Documents\ChatGPT\HackGT\withyou\frontend"

# First setup or dependency update
npm install

# Run
npm run dev -- --host 0.0.0.0
```

For a Samsung phone, use an HTTPS deployment. Mobile motion, microphone access, service workers, and PWA installation generally require a secure context; a LAN `http://` URL is not sufficient on many browsers.

## ESP32 request examples

After replacing the timestamp, an ESP32 or test client can send a reading with:

```powershell
$reading = @{
  timestamp = (Get-Date).ToUniversalTime().ToString("o")
  source = "arduino"
  sensor_type = "temperature"
  value = 74.2
  unit = "fahrenheit"
  confidence = 0.98
  is_simulated = $false
  metadata = @{ device_id = "withyou-room-01" }
} | ConvertTo-Json -Depth 4

Invoke-RestMethod `
  -Uri "http://localhost:8000/api/sensors/readings" `
  -Method Post `
  -ContentType "application/json" `
  -Body $reading
```

The acknowledgement contains `stored: false`. A valid Arduino reading changes the frontend Home Sensor status to connected while the backend process remains active.

## Security and deployment notes

- Configure `CORS_ORIGINS` to the exact production frontend origin.
- Terminate TLS at the deployment platform or reverse proxy.
- Replace the prototype in-memory rate limiter with a shared limiter for multi-instance deployment.
- Keep request logs free of authorization headers and raw audio.
- Add deployment-level request limits in addition to application limits.
- This prototype does not claim HIPAA compliance.

## Future hardware and product work

The ingestion contract is ready for temperature, humidity, light, PIR/motion, and proximity readings once the exact Arduino/ESP32 board and sensors are chosen. Future product work can add smartwatch support, adaptive baselines, notifications, and privacy-conscious caregiver summaries without redesigning the normalized sensor pipeline.
