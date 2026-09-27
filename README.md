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
- Relays the latest Pico W demo summaries through short-lived, code-paired judging sessions into each judge's local IndexedDB.
- Includes a minimal Android Health Helper for user-initiated Steps, Sleep, and Heart Rate summary sync.
- Provides reliable, labeled demo scenarios for judging.

WithYou notices changes in patterns. It does not diagnose conditions.

## Architecture

```text
Phone / Arduino / Android Health Connect / Manual Check-In
                    ↓
          Normalized SensorReading
             ↙             ↘
      Local IndexedDB    FastAPI acknowledgement
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

Personal history remains in IndexedDB or Health Connect whenever possible. The Android Health Helper reduces recent health records on the phone and uploads only compact current/baseline summaries. The backend keeps at most six of those summaries in process memory for the frontend and never retains raw Health Connect history.

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

Supported sources are `phone`, `arduino`, `watch`, and `manual`. Supported types are `activity`, `motion`, `sound_level`, `temperature`, `humidity`, `light`, `sleep`, `mood`, `proximity`, `steps`, and `heart_rate`.

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
- `POST /api/sensors/readings` — validated acknowledgement, plus latest-only temporary caching when a Pico demo code is present
- `GET /api/sensors/demo-sessions/latest` — latest-only Pico W summaries; requires the exact code in `X-Demo-Session-ID`
- `GET /api/sensors/health-connect/summaries` — at most six latest compact current/baseline Health Connect summaries
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
| `DEMO_SESSION_TTL_MINUTES` | Inactivity timeout for in-memory Pico W judging sessions | `240` |
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

The acknowledgement contains `stored: false`. A valid Arduino reading changes the frontend Home Sensor status to live while a reading has been received within 30 seconds. Older values remain visible but are labeled as the last stale reading rather than live data.

## Raspberry Pi Pico W multi-phone judging demo

The judging path is:

```text
Pico W → FastAPI's temporary code session → each judge's browser → that phone's IndexedDB
```

No account is required. Pick a private 6–12 character code, such as a randomized event code, and configure it as `DEMO_SESSION_ID` in [`backend/examples/pico_w_home_sensor.py`](backend/examples/pico_w_home_sensor.py). The first Pico reading automatically creates the in-memory session and binds that code to the Pico's `device_id`. A different device cannot reuse the active code. Codes are never listed by the API, and retrieval requires the exact code in a request header so normal URL access logs do not record it.

The temporary session store lives in one FastAPI process. For the hackathon demo, run a single Render instance/worker so every judge reaches the same in-memory store. A future multi-instance deployment should move only this short-lived latest-summary cache to a shared ephemeral store such as Redis; browsers can continue keeping their own history in IndexedDB.

The backend retains only the newest value for each sensor type in that session. It does not keep raw history. The session expires after four hours without a Pico update by default, and a backend restart clears it immediately.

### Pico W setup

1. Install current MicroPython firmware on the Pico W.
2. Install the MicroPython `urequests` package if the firmware does not already provide it.
3. Open [`pico_w_home_sensor.py`](backend/examples/pico_w_home_sensor.py) in Thonny.
4. Set `WIFI_SSID`, `WIFI_PASSWORD`, and a private `DEMO_SESSION_ID`. Never commit real Wi-Fi credentials.
5. Save the script to the Pico as `main.py` and run it. It posts temperature, humidity, and light summaries every ten seconds.
6. On each judge's phone, open WithYou, find **Room Environment**, enter the same code under **Connect to Live Home Sensor**, and tap **Connect**.
7. The browser fetches immediately, then polls the existing session endpoint every three seconds. The panel shows the latest temperature, humidity, and light value per sensor type, while each browser imports a reading only once by ID/timestamp.

The current script intentionally generates the environmental numbers while using a real Pico W, Wi-Fi, backend, and multi-phone data path. The UI labels them **Simulated environmental value**. These readings never enter Health Connect. Replace only `simulated_environment()` when real external sensors are selected.

## Android Health Connect / Samsung setup

The native **WithYou Health Helper** is in [`android/`](android/). It is intentionally separate from the PWA, so the manifest, service worker, IndexedDB data, manual inputs, phone sensors, and Arduino-ready path continue to work as before.

### Privacy-first flow

```text
Galaxy Watch → Samsung Health → Health Connect
                                  ↓
                    summarize on the Android phone
                                  ↓
       up to 6 compact, non-simulated SensorReading summaries
                                  ↓
             POST /api/sensors/readings on FastAPI
                                  ↓
       PWA Sources card shows Watch / Health connected
```

The helper is foreground-only and syncs only after a user opens it. It requests read access to Steps, Sleep, and Heart Rate—no write permission and no background sync. On the phone, it keeps today's steps, the latest completed full sleep, and the recent heart-rate average, then computes personal 30-day averages for steps, completed sleep, and heart rate. Sleep uses full parent-session intervals and merges overlapping or closely adjacent fragments instead of selecting a tiny final fragment. Raw daily values, sleep sessions/stages, heart-rate samples, and raw health history are not uploaded. The backend keeps only the latest current/baseline pair for each of the three metrics in a six-slot in-memory cache. The frontend fetches those compact summaries, explicitly separates current values from baselines, and falls back to demo values when a personal baseline is unavailable. The prototype remains non-diagnostic.

Each uploaded summary identifies `provider: health_connect`, `summary_kind: current` or `baseline`, and `raw_history_uploaded: false`. Baseline metadata contains only aggregate details such as the contributing count, range, and standard deviation.

### Source-aware activity fusion

WithYou does not require the phone, watch, and home sensor to be present together. Phone motion and watch steps keep separate personal baselines but contribute to one activity interpretation. One available movement source is used with normal confidence; agreement between both raises confidence; disagreement is reported as mixed and does not create a strong or duplicate activity alert. Missing sources are listed as unavailable rather than converted into abnormal values. Home-sensor readings add environment/presence context only and never stand in for movement evidence.

### Adaptive personal baselines

The browser keeps a compact adaptive profile in the existing IndexedDB baseline store. Each source-specific metric has a `learning`, `qualified`, or `adapting` state plus a rolling mean, standard deviation, qualified count, candidate-pattern count, and last-update time. A single outlier is recorded only as a candidate and does not move a qualified baseline. A similar change must appear on at least five distinct days before bounded adaptation begins; repeated behavior then moves the baseline gradually instead of jumping to the newest value.

Sleep duration, bedtime, and wake time adapt separately. Bedtime and wake time use circular clock arithmetic so values around midnight average correctly. Partial current-day steps are never used for learning; only the compact Health Connect completed-day baseline is eligible. Heart-rate adaptation uses compact multi-day summaries only and remains observational. Phone-motion learning is source-specific and is rejected when phone and watch activity evidence conflict.

No raw Health Connect history or backend wellness history is added. The local adaptive profile stores compact statistics and at most 30 observation identifiers solely to prevent processing the same daily summary repeatedly; it does not store the underlying daily step totals, sleep stages, or heart-rate samples.

Health Connect may combine records from Samsung Health, the phone, and other apps the user approved. WithYou therefore labels these readings as real **Health Connect summaries**, not as guaranteed Galaxy Watch measurements.

### User-controlled clinical summary

The PWA includes a lightweight **Generate summary for my doctor** flow. The report is created locally only after the user taps the button, then shown as a preview before the user chooses to copy, download, print, or save it as a PDF. WithYou never automatically sends the report and does not create a clinician account or second health database.

The report generator consumes the same interpreted `WellnessContext`, activity-fusion result, and qualified/adapting baseline profile used by the main dashboard. It accepts no raw record arrays. Learning/demo fallback values are not presented as personal clinical baselines, and the report explicitly lists confidence plus supporting, conflicting, and missing sources. Optional health/context notes are user-entered, editable/deletable, stored in the existing local IndexedDB baseline store, and included only when the user checks **My context notes**.

Every report is labeled **For discussion with a healthcare professional — not a diagnosis.** It contains no raw Health Connect history, sleep stages, individual heart-rate samples, or full daily histories.

### Build the Health Helper

1. Install a current stable Android Studio, Android SDK 36, and a JDK 17-compatible Gradle environment.
2. Open the [`android/`](android/) folder as an Android Studio project and allow Gradle sync to complete.
3. The helper defaults to `https://withyou-1g5l.onrender.com`. To use another public HTTPS backend, set `WITHYOU_API_BASE_URL` in your user Gradle properties or pass `-PWITHYOU_API_BASE_URL=https://...`.
4. Do not place `OPENAI_API_KEY` or any secret in Gradle properties used by the Android app. Only the public backend URL belongs there.
5. Run the `app` configuration on a physical Android 9+ phone. Health Connect is built into Android 14+; supported older Android versions require the Health Connect provider app.
6. The production build returns to `https://withyou-nine.vercel.app` after a web-started sync. For another public frontend, set the non-secret `WITHYOU_WEB_URL` Gradle property. The helper is a hackathon build and has no app-store listing.
7. The website’s install action expects a GitHub Release asset named `withyou-health-helper.apk` at `releases/latest/download/withyou-health-helper.apk`. Publishing that asset is a separate, explicit release step; the current debug build is suitable only for intentional hackathon sideloading.

The Android project uses stable `androidx.health.connect:connect-client:1.1.0`. See [`android/README.md`](android/README.md) for the helper's exact summary rules.

### Samsung phone test

1. Pair the Galaxy Watch with Samsung Health and confirm recent steps, sleep, or heart-rate data is visible in Samsung Health.
2. In Samsung Health, open **Settings → Health Connect**, connect Samsung Health, and allow Samsung Health to write the three data types. Menu wording can vary by Samsung Health version.
3. On Android 14+, open **Settings → Security and privacy → Privacy controls → Health Connect**. On Android 13 or lower, install/open the Health Connect app from Google Play.
4. Install/run **WithYou Health Helper** from Android Studio. It is not published in an app store.
5. Open `https://withyou-nine.vercel.app` in Chrome on the same phone and tap **Connect Health**. Android should open the helper directly.
6. Enable Steps, Sleep, and Heart Rate when Android asks. The helper should perform one foreground sync, list only compact available summaries, and return to WithYou.
7. The PWA should check immediately, then continue polling every 15 seconds. **Health** should change to Connected / Synced and show the latest steps, sleep, and heart-rate summaries without a manual refresh.
8. If the helper is not installed, confirm the PWA stays open, shows the single **Install WithYou Health Helper** action, and explains Android’s install confirmation.
9. Confirm the manual sleep/mood controls, motion, Home Sensor, companion text/explicit voice input, and installed PWA still behave normally.

If no summaries appear, first confirm Samsung Health has written records into Health Connect under **Data and access**, then recheck WithYou Health Helper's three read permissions. The backend connection status is prototype in-memory state and resets when the Render process restarts.

## Security and deployment notes

- Configure `CORS_ORIGINS` to the exact production frontend origin.
- Terminate TLS at the deployment platform or reverse proxy.
- Replace the prototype in-memory rate limiter with a shared limiter for multi-instance deployment.
- Keep request logs free of authorization headers and raw audio.
- Add deployment-level request limits in addition to application limits.
- This prototype does not claim HIPAA compliance.

## Future hardware and product work

The current hackathon scope already includes Health Connect summaries, adaptive personal baselines, source-aware fusion, and the user-controlled clinical/caregiver summary described above. The normalized ingestion contract remains extensible, but PIR, geofencing, additional physical sensors, background synchronization, notifications, clinician accounts, and other product expansion are intentionally not implemented in this submission.
