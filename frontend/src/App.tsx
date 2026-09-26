import { useEffect, useMemo, useRef, useState } from 'react'
import { apiUrl } from './api'
import {
  clearLocalData,
  DEMO_BASELINE,
  getTodaySensorReadings,
  initializeDatabase,
  saveReading,
  saveSensorReading,
} from './db'
import { startMotionSession, type MotionSession } from './motion'
import { analyzePatterns, buildWellnessContext, latestReading } from './patternAnalyzer'
import { measureEnvironmentSound, type SoundClassification } from './sound'
import type {
  ActivityReading,
  ActivityState,
  BaselineProfile,
  CompanionResult,
  SensorReading,
} from './types'
import './styles.css'

type SensorStatus = 'awaiting' | 'starting' | 'connected' | 'unavailable' | 'stopped'
type SoundStatus = 'awaiting' | 'measuring' | 'connected' | 'unavailable'

const DEMO_LEVELS: Record<ActivityState, number> = {
  still: 0.08,
  walking: 0.58,
  active: 0.9,
  sleeping: 0.02,
}
const MOOD_SCORES: Record<string, number> = {
  good: 0.9,
  okay: 0.65,
  tired: 0.42,
  stressed: 0.3,
  overwhelmed: 0.18,
  sad: 0.22,
}

function formatTime(timestamp?: string) {
  if (!timestamp) return 'No reading yet'
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp))
}

function localInputValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function defaultSleepTimes() {
  const wake = new Date()
  wake.setHours(7, 0, 0, 0)
  const start = new Date(wake)
  start.setDate(start.getDate() - 1)
  start.setHours(23, 0, 0, 0)
  return { start: localInputValue(start), wake: localInputValue(wake) }
}

function soundReading(classification: SoundClassification, value: number): SensorReading {
  return {
    timestamp: new Date().toISOString(),
    source: 'phone',
    sensor_type: 'sound_level',
    value,
    unit: 'relative',
    confidence: 0.9,
    is_simulated: true,
    metadata: { classification },
  }
}

function activitySensor(reading: ActivityReading): SensorReading {
  return {
    timestamp: reading.timestamp,
    source: reading.source,
    sensor_type: 'activity',
    value: reading.activity_level,
    unit: 'relative',
    confidence: reading.is_simulated ? 1 : 0.72,
    is_simulated: reading.is_simulated,
    metadata: { state: reading.state, window_seconds: reading.is_simulated ? 0 : 3 },
  }
}

function environmentReading(
  sensorType: 'temperature' | 'humidity' | 'light',
  value: number,
  unit: string,
  label: string,
): SensorReading {
  return {
    timestamp: new Date().toISOString(),
    source: 'arduino',
    sensor_type: sensorType,
    value,
    unit,
    confidence: 1,
    is_simulated: true,
    metadata: { label, hardware_status: 'simulated_until_connected' },
  }
}

function safeLocalCompanion(contextReasons: string[]): CompanionResult {
  const observation = contextReasons[0]
  return {
    text: observation
      ? `I noticed ${observation.charAt(0).toLowerCase()}${observation.slice(1)}. Thanks for checking in. How are you feeling about today?`
      : 'Thanks for checking in. I’m here with you. What would feel most helpful to talk through right now?',
    observations_used: observation ? [observation] : [],
    used_ai: false,
  }
}

export default function App() {
  const sleepDefaults = useMemo(defaultSleepTimes, [])
  const [baseline, setBaseline] = useState<BaselineProfile>(DEMO_BASELINE)
  const [readings, setReadings] = useState<SensorReading[]>([])
  const [motionStatus, setMotionStatus] = useState<SensorStatus>('awaiting')
  const [motionMessage, setMotionMessage] = useState('Tap Start motion to request phone motion access.')
  const [soundStatus, setSoundStatus] = useState<SoundStatus>('awaiting')
  const [soundMessage, setSoundMessage] = useState('Sound level is measured only when you ask.')
  const [sleepStart, setSleepStart] = useState(sleepDefaults.start)
  const [wakeTime, setWakeTime] = useState(sleepDefaults.wake)
  const [sleepMessage, setSleepMessage] = useState('')
  const [customMood, setCustomMood] = useState('')
  const [storageError, setStorageError] = useState<string | null>(null)
  const [homeConnected, setHomeConnected] = useState(false)
  const [companionInput, setCompanionInput] = useState('')
  const [companionResult, setCompanionResult] = useState<CompanionResult | null>(null)
  const [companionBusy, setCompanionBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [voiceMessage, setVoiceMessage] = useState('')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const sessionRef = useRef<MotionSession | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  useEffect(() => {
    async function loadLocalData() {
      try {
        const [savedBaseline, today] = await Promise.all([initializeDatabase(), getTodaySensorReadings()])
        setBaseline(savedBaseline)
        setReadings(today)
      } catch {
        setStorageError('Local storage could not be opened. Readings will not persist in this browser.')
      }
    }
    void loadLocalData()

    if (!('DeviceMotionEvent' in window)) {
      setMotionStatus('unavailable')
      setMotionMessage('Motion sensing is unavailable here. Demo controls are ready.')
    }

    return () => {
      sessionRef.current?.stop()
      mediaRecorderRef.current?.stream.getTracks().forEach((track) => track.stop())
    }
  }, [])

  useEffect(() => {
    if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('/sw.js')
  }, [])

  useEffect(() => {
    let active = true
    const checkHomeSensor = async () => {
      try {
        const response = await fetch(apiUrl('/api/sensors/health'))
        if (!response.ok) return
        const payload = await response.json() as { last_source?: string | null }
        if (active) setHomeConnected(payload.last_source === 'arduino')
      } catch {
        if (active) setHomeConnected(false)
      }
    }
    void checkHomeSensor()
    const interval = window.setInterval(() => void checkHomeSensor(), 15_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [])

  const pattern = useMemo(() => analyzePatterns(readings, baseline), [readings, baseline])
  const wellnessContext = useMemo(() => buildWellnessContext(readings, baseline, pattern), [readings, baseline, pattern])
  const activity = latestReading(readings, 'activity')
  const sleep = latestReading(readings, 'sleep')
  const sound = latestReading(readings, 'sound_level')
  const temperature = latestReading(readings, 'temperature')
  const humidity = latestReading(readings, 'humidity')
  const light = latestReading(readings, 'light')
  const mood = latestReading(readings, 'mood')
  const activityDifference = activity
    ? ((activity.value - baseline.normal_activity_level) / baseline.normal_activity_level) * 100
    : null

  const recordSensor = async (reading: SensorReading) => {
    setReadings((current) => [...current, reading])
    try {
      const saved = await saveSensorReading(reading)
      setReadings((current) => current.map((item) => item === reading ? saved : item))
    } catch {
      setStorageError('A reading updated the dashboard but could not be saved to IndexedDB.')
    }
  }

  const recordSensors = async (newReadings: SensorReading[]) => {
    for (const reading of newReadings) await recordSensor(reading)
  }

  const recordActivity = async (reading: ActivityReading) => {
    await Promise.all([recordSensor(activitySensor(reading)), saveReading(reading)])
  }

  const handleStartMotion = async () => {
    sessionRef.current?.stop()
    setMotionStatus('starting')
    setMotionMessage('Requesting motion access…')
    try {
      const session = await startMotionSession(
        (reading) => {
          setMotionStatus('connected')
          setMotionMessage('Phone motion is summarized every three seconds.')
          void recordActivity(reading)
        },
        (message) => {
          setMotionStatus('unavailable')
          setMotionMessage(message)
          sessionRef.current = null
        },
      )
      sessionRef.current = session
      if (session) setMotionMessage('Listening for the first motion window…')
    } catch {
      setMotionStatus('unavailable')
      setMotionMessage('Motion permission failed. Demo controls are ready.')
    }
  }

  const handleStopMotion = () => {
    sessionRef.current?.stop()
    sessionRef.current = null
    setMotionStatus('stopped')
    setMotionMessage('Motion sensing stopped. Saved summaries remain local.')
  }

  const addDemoActivity = (state: ActivityState, level = DEMO_LEVELS[state]) => {
    void recordActivity({
      timestamp: new Date().toISOString(),
      source: 'phone',
      activity_level: level,
      state,
      is_simulated: true,
    })
  }

  const handleMeasureSound = async () => {
    setSoundStatus('measuring')
    setSoundMessage('Requesting microphone access…')
    try {
      const reading = await measureEnvironmentSound(setSoundMessage)
      await recordSensor(reading)
      setSoundStatus('connected')
      setSoundMessage(`Measured a ${String(reading.metadata.classification)} environment. No recording was saved.`)
    } catch {
      setSoundStatus('unavailable')
      setSoundMessage('Microphone access failed. Quiet, Normal, and Loud demos are available.')
    }
  }

  const saveSleep = async () => {
    const start = new Date(sleepStart)
    const wake = new Date(wakeTime)
    const hours = (wake.getTime() - start.getTime()) / 3_600_000
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      setSleepMessage('Choose a sleep start and wake time within a 24-hour period.')
      return
    }
    await recordSensor({
      timestamp: new Date().toISOString(),
      source: 'manual',
      sensor_type: 'sleep',
      value: Number(hours.toFixed(2)),
      unit: 'hours',
      confidence: 1,
      is_simulated: false,
      metadata: { sleep_start: start.toISOString(), wake_time: wake.toISOString() },
    })
    setSleepMessage(`Saved ${hours.toFixed(1)} hours locally.`)
  }

  const checkInMood = (label: string, customText?: string, simulated = false) => {
    const normalized = label.toLowerCase()
    void recordSensor({
      timestamp: new Date().toISOString(),
      source: 'manual',
      sensor_type: 'mood',
      value: MOOD_SCORES[normalized] ?? 0.5,
      unit: 'check_in',
      confidence: 1,
      is_simulated: simulated,
      metadata: { label: normalized, custom_text: customText?.slice(0, 160) ?? null },
    })
    setCustomMood('')
  }

  const runDemo = (scenario: string) => {
    const now = new Date().toISOString()
    const activityDemo = (value: number, state: ActivityState): SensorReading => ({
      timestamp: now, source: 'phone', sensor_type: 'activity', value, unit: 'relative', confidence: 1,
      is_simulated: true, metadata: { state, scenario },
    })
    const sleepDemo = (hours: number): SensorReading => ({
      timestamp: now, source: 'manual', sensor_type: 'sleep', value: hours, unit: 'hours', confidence: 1,
      is_simulated: true, metadata: { wake_time: new Date().toISOString(), scenario },
    })
    const moodDemo = (label: string): SensorReading => ({
      timestamp: now, source: 'manual', sensor_type: 'mood', value: MOOD_SCORES[label] ?? 0.5, unit: 'check_in',
      confidence: 1, is_simulated: true, metadata: { label, scenario },
    })
    const demoMap: Record<string, SensorReading[]> = {
      normal: [activityDemo(0.68, 'walking'), sleepDemo(7.6), moodDemo('good'), soundReading('normal', 0.4), environmentReading('temperature', 72, 'fahrenheit', 'normal room')],
      low: [activityDemo(0.25, 'still')],
      sleep: [sleepDemo(4.8)],
      stress: [moodDemo('stressed')],
      loud: [soundReading('loud', 0.86)],
      warm: [environmentReading('temperature', 83, 'fahrenheit', 'warm room')],
      combined: [activityDemo(0.24, 'still'), sleepDemo(4.9), moodDemo('stressed'), soundReading('loud', 0.84), environmentReading('temperature', 82, 'fahrenheit', 'warm room')],
    }
    void recordSensors(demoMap[scenario] ?? [])
  }

  const sendTypedMessage = async () => {
    const message = companionInput.trim()
    if (!message) return
    setCompanionBusy(true)
    setAudioUrl(null)
    try {
      const response = await fetch(apiUrl('/api/companion/respond'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wellness_context: wellnessContext, user_message: message }),
      })
      if (!response.ok) throw new Error('companion unavailable')
      setCompanionResult(await response.json() as CompanionResult)
    } catch {
      setCompanionResult(safeLocalCompanion(pattern.reasons))
    } finally {
      setCompanionBusy(false)
      setCompanionInput('')
    }
  }

  const submitVoice = async (blob: Blob) => {
    setCompanionBusy(true)
    setVoiceMessage('Transcribing and preparing a response…')
    const form = new FormData()
    const extension = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm'
    form.append('audio', blob, `withyou-voice.${extension}`)
    form.append('wellness_context', JSON.stringify(wellnessContext))
    try {
      const response = await fetch(apiUrl('/api/companion/voice'), { method: 'POST', body: form })
      if (!response.ok) throw new Error('voice unavailable')
      const result = await response.json() as CompanionResult
      setCompanionResult(result)
      if (result.audio_base64 && result.audio_mime_type) {
        setAudioUrl(`data:${result.audio_mime_type};base64,${result.audio_base64}`)
      } else {
        setAudioUrl(null)
      }
      setVoiceMessage(result.audio_available ? 'Response ready. The playback voice is AI-generated.' : 'Text response ready; spoken playback was unavailable.')
    } catch {
      setCompanionResult(safeLocalCompanion(pattern.reasons))
      setVoiceMessage('Voice processing was unavailable. Typed chat still works.')
    } finally {
      audioChunksRef.current = []
      setCompanionBusy(false)
    }
  }

  const startVoice = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceMessage('Voice recording is unavailable here. Typed chat still works.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const preferred = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream)
      audioChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        const baseType = recorder.mimeType.split(';')[0] || 'audio/webm'
        const blob = new Blob(audioChunksRef.current, { type: baseType })
        void submitVoice(blob)
      }
      recorder.start()
      mediaRecorderRef.current = recorder
      setRecording(true)
      setVoiceMessage('Recording… Tap Stop when you’re finished.')
    } catch {
      setVoiceMessage('Microphone permission failed. Typed chat still works.')
    }
  }

  const stopVoice = () => {
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
    setRecording(false)
  }

  const deleteData = async () => {
    if (!window.confirm('Delete all WithYou data stored in this browser? This cannot be undone.')) return
    try {
      const resetBaseline = await clearLocalData()
      setBaseline(resetBaseline)
      setReadings([])
      setCompanionResult(null)
      setAudioUrl(null)
      setStorageError(null)
    } catch {
      setStorageError('Local data could not be deleted in this browser.')
    }
  }

  const activityState = typeof activity?.metadata.state === 'string' ? activity.metadata.state : 'waiting'
  const soundClass = typeof sound?.metadata.classification === 'string' ? sound.metadata.classification : 'not measured'
  const moodLabel = typeof mood?.metadata.label === 'string' ? mood.metadata.label : 'Not checked in'

  return (
    <main className="app-shell">
      <header className="hero" id="home">
        <div className="brand-mark" aria-hidden="true">W</div>
        <div className="hero-copy">
          <p className="eyebrow">Private by design</p>
          <h1>WithYou</h1>
          <p className="tagline">Someone in your corner, even when you live alone.</p>
        </div>
        <nav className="top-nav" aria-label="Page sections">
          <a href="#home">Home</a><a href="#companion">WithYou</a><a href="#sources">Sources</a>
        </nav>
      </header>

      <section className="notice" aria-label="Prototype notice">
        <span className="notice-dot" />
        <p><strong>HackGT prototype</strong> — baseline and environment demos are clearly simulated.</p>
      </section>

      <section className="pattern-hero card" aria-labelledby="pattern-heading">
        <div>
          <p className="eyebrow">Today’s Pattern</p>
          <h2 id="pattern-heading">{pattern.status === 'changed' ? 'Something is different today' : 'Things look within your normal'}</h2>
          <p className="pattern-copy">
            {pattern.reasons[0] ?? 'Add a reading or check-in to start building today’s local picture.'}
          </p>
        </div>
        <span className={`pattern-badge ${pattern.status}`}>{pattern.status === 'changed' ? 'Different' : 'Normal'}</span>
      </section>

      <section className="metric-grid" aria-label="Today summary">
        <article className="metric-card"><span>Activity</span><strong>{activity ? `${Math.round(activity.value * 100)}%` : '—'}</strong><small>{activityState}</small></article>
        <article className="metric-card"><span>Sleep</span><strong>{sleep ? `${sleep.value.toFixed(1)}h` : '—'}</strong><small>normal 7.5h</small></article>
        <article className="metric-card"><span>Environment</span><strong>{temperature ? `${temperature.value.toFixed(0)}°` : sound ? soundClass : '—'}</strong><small>{temperature?.is_simulated ? 'simulated' : sound ? 'sound level' : 'no reading'}</small></article>
        <article className="metric-card"><span>Mood</span><strong className="metric-word">{moodLabel}</strong><small>voluntary only</small></article>
      </section>

      <section className="card comparison-card" aria-labelledby="comparison-heading">
        <div className="section-heading">
          <div><p className="eyebrow">Explainable comparison</p><h2 id="comparison-heading">Today vs Your Normal</h2></div>
          <span className={`pill ${pattern.status}`}>{pattern.status}</span>
        </div>
        <div className="comparison-row">
          <div><span>Current activity</span><strong>{activity ? activity.value.toFixed(2) : '—'}</strong></div>
          <div><span>Demo baseline</span><strong>{baseline.normal_activity_level.toFixed(2)}</strong></div>
          <div><span>Difference</span><strong>{activityDifference == null ? '—' : `${activityDifference >= 0 ? '+' : ''}${activityDifference.toFixed(0)}%`}</strong></div>
        </div>
        <div className="reason-list">
          {pattern.reasons.length ? pattern.reasons.map((reason) => <p key={reason}>• {reason}</p>) : <p>No meaningful changes detected from the available summaries.</p>}
        </div>
        {pattern.check_in_recommended && <p className="check-in-prompt">A few signals changed together. How are you feeling?</p>}
      </section>

      <div className="two-column">
        <section className="card controls" aria-labelledby="motion-heading">
          <div className="section-heading"><div><p className="eyebrow">Phone motion</p><h2 id="motion-heading">Movement</h2></div>{activity?.is_simulated && <span className="pill demo">Simulated</span>}</div>
          <div className="primary-controls">
            <button className="primary" onClick={() => void handleStartMotion()} disabled={motionStatus === 'starting' || motionStatus === 'connected'}>Start motion</button>
            <button className="secondary-button" onClick={handleStopMotion} disabled={!sessionRef.current}>Stop</button>
          </div>
          <p className={`sensor-message ${motionStatus === 'unavailable' ? 'warning' : ''}`}>{motionMessage}</p>
          <div className="demo-buttons compact">
            <button onClick={() => addDemoActivity('still')}>Sitting Still</button>
            <button onClick={() => addDemoActivity('walking')}>Walking</button>
            <button onClick={() => addDemoActivity('active')}>Active</button>
            <button onClick={() => addDemoActivity('sleeping')}>Sleeping</button>
          </div>
        </section>

        <section className="card controls" aria-labelledby="sound-heading">
          <div className="section-heading"><div><p className="eyebrow">Phone microphone</p><h2 id="sound-heading">Environment Sound</h2></div>{sound?.is_simulated && <span className="pill demo">Simulated</span>}</div>
          <button className="primary" onClick={() => void handleMeasureSound()} disabled={soundStatus === 'measuring'}>{soundStatus === 'measuring' ? 'Measuring…' : 'Measure environment'}</button>
          <p className={`sensor-message ${soundStatus === 'unavailable' ? 'warning' : ''}`}>{soundMessage}</p>
          <div className="demo-buttons compact">
            <button onClick={() => void recordSensor(soundReading('quiet', 0.08))}>Quiet</button>
            <button onClick={() => void recordSensor(soundReading('normal', 0.42))}>Normal</button>
            <button onClick={() => void recordSensor(soundReading('loud', 0.86))}>Loud</button>
          </div>
          <p className="microcopy">Measures amplitude only. No recording or transcription.</p>
        </section>
      </div>

      <div className="two-column">
        <section className="card" aria-labelledby="sleep-heading">
          <div className="section-heading"><div><p className="eyebrow">Manual entry</p><h2 id="sleep-heading">Sleep</h2></div></div>
          <div className="field-grid">
            <label>Sleep start<input type="datetime-local" value={sleepStart} onChange={(event) => setSleepStart(event.target.value)} /></label>
            <label>Wake time<input type="datetime-local" value={wakeTime} onChange={(event) => setWakeTime(event.target.value)} /></label>
          </div>
          <button className="primary" onClick={() => void saveSleep()}>Save sleep locally</button>
          <p className="sensor-message">{sleepMessage || 'Demo normal: 7.5 hours, wake at 8:30 AM.'}</p>
        </section>

        <section className="card" aria-labelledby="mood-heading">
          <div className="section-heading"><div><p className="eyebrow">Voluntary check-in</p><h2 id="mood-heading">How are you feeling?</h2></div></div>
          <div className="mood-buttons">
            {Object.keys(MOOD_SCORES).map((label) => <button key={label} onClick={() => checkInMood(label)}>{label}</button>)}
          </div>
          <div className="inline-input"><input aria-label="Custom mood check-in" value={customMood} maxLength={160} placeholder="Something else…" onChange={(event) => setCustomMood(event.target.value)} /><button onClick={() => customMood.trim() && checkInMood('custom', customMood.trim())}>Save</button></div>
          <p className="microcopy">Mood comes only from you. WithYou never infers it from sound.</p>
        </section>
      </div>

      <section className="card" aria-labelledby="environment-heading">
        <div className="section-heading"><div><p className="eyebrow">Arduino-ready schema</p><h2 id="environment-heading">Room Environment</h2></div><span className="pill demo">Simulated controls</span></div>
        <div className="environment-summary">
          <span>Temperature <strong>{temperature ? `${temperature.value} °F` : '—'}</strong></span>
          <span>Humidity <strong>{humidity ? `${humidity.value}%` : '—'}</strong></span>
          <span>Light <strong>{light ? `${light.value} lux` : '—'}</strong></span>
        </div>
        <div className="demo-buttons">
          <button onClick={() => void recordSensors([environmentReading('temperature', 72, 'fahrenheit', 'normal room'), environmentReading('humidity', 45, 'percent', 'normal room'), environmentReading('light', 400, 'lux', 'normal room')])}>Normal Room</button>
          <button onClick={() => void recordSensor(environmentReading('temperature', 83, 'fahrenheit', 'warm room'))}>Warm Room</button>
          <button onClick={() => void recordSensor(environmentReading('temperature', 63, 'fahrenheit', 'cool room'))}>Cool Room</button>
          <button onClick={() => void recordSensor(environmentReading('light', 35, 'lux', 'low light'))}>Low Light</button>
          <button onClick={() => void recordSensor(environmentReading('humidity', 78, 'percent', 'high humidity'))}>High Humidity</button>
        </div>
        <p className="microcopy">Phones are not treated as room-temperature sensors. These readings use tomorrow’s external-device format.</p>
      </section>

      <section className="card demo-panel" aria-labelledby="demo-heading">
        <div className="section-heading"><div><p className="eyebrow">Judge-friendly</p><h2 id="demo-heading">Demo Mode</h2></div><span className="pill demo">All simulated</span></div>
        <div className="demo-buttons">
          <button onClick={() => runDemo('normal')}>Normal Day</button><button onClick={() => runDemo('low')}>Low Activity</button>
          <button onClick={() => runDemo('sleep')}>Poor Sleep</button><button onClick={() => runDemo('stress')}>Stress Check-In</button>
          <button onClick={() => runDemo('loud')}>Loud Environment</button><button onClick={() => runDemo('warm')}>Warm Room</button>
          <button className="accent-button" onClick={() => runDemo('combined')}>Combined Different Day</button>
        </div>
      </section>

      <section className="card companion-card" id="companion" aria-labelledby="companion-heading">
        <div className="section-heading"><div><p className="eyebrow">Notice · Ask · Listen · Support</p><h2 id="companion-heading">Talk with WithYou</h2></div></div>
        <div className="chat-input-row">
          <textarea aria-label="Message WithYou" value={companionInput} maxLength={1000} placeholder="Tell WithYou how today is going…" onChange={(event) => setCompanionInput(event.target.value)} />
          <button className="primary" onClick={() => void sendTypedMessage()} disabled={companionBusy || !companionInput.trim()}>Send</button>
        </div>
        <div className="voice-controls">
          {!recording ? <button onClick={() => void startVoice()} disabled={companionBusy}>Talk to WithYou 🎙️</button> : <button className="recording-button" onClick={stopVoice}>Stop recording</button>}
          <span>{voiceMessage}</span>
        </div>
        {companionResult && <div className="conversation">
          {companionResult.transcript && <div><span>You said</span><p>{companionResult.transcript}</p></div>}
          <div><span>WithYou {companionResult.used_ai ? '· AI response' : '· safe local response'}</span><p>{companionResult.text}</p></div>
          {audioUrl && <div><span>AI-generated voice</span><audio controls src={audioUrl}>Spoken response</audio></div>}
        </div>}
        <p className="microcopy">Only the compact summary shown above and your message are sent to the backend—not your full local history.</p>
      </section>

      <section className="card" id="sources" aria-labelledby="sources-heading">
        <div className="section-heading"><div><p className="eyebrow">Connections</p><h2 id="sources-heading">Sources</h2></div></div>
        <div className="source-grid">
          <div className="source-item"><span className={`status-dot ${motionStatus === 'connected' ? 'online' : ''}`} /><div><strong>Phone Motion</strong><span>{motionStatus === 'connected' ? 'Connected' : 'Permission required'}</span></div></div>
          <div className="source-item"><span className={`status-dot ${soundStatus === 'connected' ? 'online' : ''}`} /><div><strong>Phone Sound</strong><span>{soundStatus === 'connected' ? 'Connected' : 'Permission required'}</span></div></div>
          <div className="source-item muted"><span className="status-dot" /><div><strong>Watch</strong><span>Not connected</span></div></div>
          <div className={`source-item ${homeConnected ? '' : 'muted'}`}><span className={`status-dot ${homeConnected ? 'online' : ''}`} /><div><strong>Home Sensor</strong><span>{homeConnected ? 'Connected via API' : 'Not connected'}</span></div></div>
        </div>
      </section>

      <section className="privacy-card" aria-labelledby="privacy-heading">
        <div><p className="eyebrow">Your data</p><h2 id="privacy-heading">Privacy controls</h2></div>
        <div className="privacy-copy">
          <p>WithYou notices changes in patterns. It does not diagnose conditions.</p>
          <p>Raw wellness history stays on your device whenever possible.</p>
          <p>Environmental sound sensing measures sound level only. It does not record or analyze conversations.</p>
        </div>
        <button className="danger-button" onClick={() => void deleteData()}>Delete My Local Data</button>
      </section>

      {storageError && <p className="error floating-error" role="alert">{storageError}</p>}
    </main>
  )
}
