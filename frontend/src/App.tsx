import { useEffect, useMemo, useRef, useState } from 'react'
import { apiUrl } from './api'
import {
  clearLocalData,
  deleteClinicalContext,
  DEMO_BASELINE,
  getTodaySensorReadings,
  initializeDatabase,
  loadAdaptiveBaseline,
  loadClinicalContext,
  saveReading,
  saveAdaptiveBaseline,
  saveClinicalContext,
  saveSensorReading,
  saveSensorReadingIfNew,
} from './db'
import {
  adaptiveBaselineState,
  applyAdaptiveBaseline,
  buildLearningInputs,
  createAdaptiveProfile,
  restoreAdaptiveProfile,
  updateAdaptiveProfile,
} from './adaptiveBaseline'
import {
  homeSensorFreshness,
  homeSensorValueLabel,
  isValidDemoCode,
  latestHomeSensorReadings,
  normalizeDemoCode,
  startHomeSensorPolling,
} from './homeSensor'
import { fetchHealthConnectSummaries } from './healthConnect'
import {
  applyHealthConnectBaselines,
  currentHealthReadings,
  selectHealthConnectSummaries,
} from './healthSummarySelection'
import { startMotionSession, type MotionSession } from './motion'
import { analyzePatterns, buildWellnessContext, latestReading } from './patternAnalyzer'
import { measureEnvironmentSound, type SoundClassification } from './sound'
import {
  CLINICAL_SUMMARY_DISCLAIMER,
  generateClinicalSummary,
  type ClinicalSummary,
} from './clinicalSummary'
import { BaselineComparison, type BaselineComparisonRow } from './components/BaselineComparison'
import { OverlayPanel } from './components/OverlayPanel'
import { SourceRail } from './components/SourceRail'
import {
  buildSourceRailItems,
  buildTodayPresentation,
  formatPersonalDelta,
  readableSourceName,
  type SourceRailId,
} from './uiPresentation'
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
type ExternalSourceHealth = {
  connected?: boolean
  last_reading_at?: string | null
  last_sensor_type?: string | null
}

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

function localDateValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function defaultClinicalDateRange() {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 29)
  return { start: localDateValue(start), end: localDateValue(end) }
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
  const clinicalDateDefaults = useMemo(defaultClinicalDateRange, [])
  const [baseline, setBaseline] = useState<BaselineProfile>(DEMO_BASELINE)
  const [adaptiveProfile, setAdaptiveProfile] = useState(() => createAdaptiveProfile(DEMO_BASELINE))
  const [adaptiveLoaded, setAdaptiveLoaded] = useState(false)
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
  const [demoCodeInput, setDemoCodeInput] = useState('')
  const [homeSessionId, setHomeSessionId] = useState('')
  const [homeSessionPollKey, setHomeSessionPollKey] = useState(0)
  const [homeSessionReadings, setHomeSessionReadings] = useState<SensorReading[]>([])
  const [homeSessionUpdatedAt, setHomeSessionUpdatedAt] = useState<string | null>(null)
  const [homeSessionSimulated, setHomeSessionSimulated] = useState(false)
  const [homeSessionClock, setHomeSessionClock] = useState(() => Date.now())
  const [homeSessionMessage, setHomeSessionMessage] = useState('Enter the Pico W demo code to receive live readings on this phone.')
  const [watchHealth, setWatchHealth] = useState<ExternalSourceHealth>({})
  const [healthSummaryReadings, setHealthSummaryReadings] = useState<SensorReading[]>([])
  const [companionInput, setCompanionInput] = useState('')
  const [companionResult, setCompanionResult] = useState<CompanionResult | null>(null)
  const [companionBusy, setCompanionBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [voiceMessage, setVoiceMessage] = useState('')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [clinicalStartDate, setClinicalStartDate] = useState(clinicalDateDefaults.start)
  const [clinicalEndDate, setClinicalEndDate] = useState(clinicalDateDefaults.end)
  const [clinicalIncludeSleep, setClinicalIncludeSleep] = useState(true)
  const [clinicalIncludeActivity, setClinicalIncludeActivity] = useState(true)
  const [clinicalIncludeHeartRate, setClinicalIncludeHeartRate] = useState(true)
  const [clinicalIncludeContext, setClinicalIncludeContext] = useState(false)
  const [clinicalContext, setClinicalContext] = useState('')
  const [clinicalSummary, setClinicalSummary] = useState<ClinicalSummary | null>(null)
  const [clinicalMessage, setClinicalMessage] = useState('Nothing is generated or shared until you choose.')
  const [activeSourcePanel, setActiveSourcePanel] = useState<SourceRailId | null>(null)
  const [clinicalPanelOpen, setClinicalPanelOpen] = useState(false)
  const sessionRef = useRef<MotionSession | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  useEffect(() => {
    async function loadLocalData() {
      try {
        const [savedBaseline, today] = await Promise.all([initializeDatabase(), getTodaySensorReadings()])
        const [savedAdaptive, savedContext] = await Promise.all([
          loadAdaptiveBaseline(),
          loadClinicalContext(),
        ])
        setBaseline(savedBaseline)
        setAdaptiveProfile(restoreAdaptiveProfile(savedAdaptive, savedBaseline))
        setClinicalContext(savedContext?.notes ?? '')
        setAdaptiveLoaded(true)
        setReadings(today)
      } catch {
        setAdaptiveLoaded(true)
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
    const checkExternalSensors = async () => {
      try {
        const response = await fetch(apiUrl('/api/sensors/health'))
        if (!response.ok) return
        const payload = await response.json() as {
          last_source?: string | null
          last_reading_at?: string | null
          last_sensor_type?: string | null
          sources?: Record<string, ExternalSourceHealth>
        }
        if (active) {
          setWatchHealth(payload.sources?.watch ?? (payload.last_source === 'watch'
            ? {
                connected: true,
                last_reading_at: payload.last_reading_at,
                last_sensor_type: payload.last_sensor_type,
              }
            : {}))
        }
        try {
          const healthSummaries = await fetchHealthConnectSummaries()
          if (active) setHealthSummaryReadings(healthSummaries.summaries)
        } catch {
          if (active) setHealthSummaryReadings([])
        }
      } catch {
        if (active) {
          setWatchHealth({})
          setHealthSummaryReadings([])
        }
      }
    }
    void checkExternalSensors()
    const interval = window.setInterval(() => void checkExternalSensors(), 15_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (!homeSessionId) return
    const stopPolling = startHomeSensorPolling(homeSessionId, {
      onResult: async (payload) => {
        const latestReadings = latestHomeSensorReadings(payload.readings)
        const newestReadingTime = latestReadings.reduce(
          (newest, reading) => Math.max(newest, new Date(reading.timestamp).getTime()),
          0,
        )
        const payloadUpdatedTime = payload.updated_at ? new Date(payload.updated_at).getTime() : 0
        const newestTime = Math.max(newestReadingTime, payloadUpdatedTime)
        const updatedAt = newestTime > 0 ? new Date(newestTime).toISOString() : null
        setHomeSessionReadings(latestReadings)
        setHomeSessionUpdatedAt(updatedAt)
        setHomeSessionSimulated(latestReadings.some((reading) => reading.is_simulated))
        setHomeSessionClock(Date.now())
        setHomeSessionMessage(`Receiving latest values from ${payload.device_id}. New values are saved in this browser.`)

        const imported: SensorReading[] = []
        for (const reading of latestReadings) {
          try {
            const saved = await saveSensorReadingIfNew(reading)
            if (saved) imported.push(saved)
          } catch {
            setStorageError('A live home-sensor reading could not be saved to IndexedDB.')
          }
        }
        if (imported.length) setReadings((current) => [...current, ...imported])
      },
      onError: (error) => {
        setHomeSessionClock(Date.now())
        setHomeSessionMessage(error instanceof Error && error.message === 'demo_session_missing'
          ? `Waiting for a Pico W using code ${homeSessionId}…`
          : 'The session service is temporarily unavailable. The last Pico reading remains visible and will be labeled by freshness.')
      },
    })
    const clockInterval = window.setInterval(() => setHomeSessionClock(Date.now()), 1_000)
    return () => {
      stopPolling()
      window.clearInterval(clockInterval)
    }
  }, [homeSessionId, homeSessionPollKey])

  const selectedHealthSummaries = useMemo(
    () => selectHealthConnectSummaries(healthSummaryReadings),
    [healthSummaryReadings],
  )
  const healthBaseline = useMemo(
    () => applyHealthConnectBaselines(baseline, selectedHealthSummaries),
    [baseline, selectedHealthSummaries],
  )
  const effectiveBaseline = useMemo(
    () => applyAdaptiveBaseline(healthBaseline, adaptiveProfile),
    [healthBaseline, adaptiveProfile],
  )
  const comparisonReadings = useMemo(
    () => [...readings, ...currentHealthReadings(selectedHealthSummaries)],
    [readings, selectedHealthSummaries],
  )
  const pattern = useMemo(
    () => analyzePatterns(comparisonReadings, effectiveBaseline),
    [comparisonReadings, effectiveBaseline],
  )
  const learning = useMemo(
    () => buildLearningInputs(comparisonReadings, selectedHealthSummaries, pattern.activity_fusion),
    [comparisonReadings, selectedHealthSummaries, pattern.activity_fusion],
  )
  useEffect(() => {
    if (!adaptiveLoaded) return
    setAdaptiveProfile((current) => {
      const next = updateAdaptiveProfile(current, learning)
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      void saveAdaptiveBaseline(next).catch(() => {
        setStorageError('The adaptive baseline updated in memory but could not be saved locally.')
      })
      return next
    })
  }, [adaptiveLoaded, learning])
  const wellnessContext = useMemo(
    () => buildWellnessContext(comparisonReadings, effectiveBaseline, pattern, adaptiveProfile),
    [comparisonReadings, effectiveBaseline, pattern, adaptiveProfile],
  )
  const activity = latestReading(comparisonReadings, 'activity')
  const sleep = latestReading(comparisonReadings, 'sleep')
  const steps = latestReading(comparisonReadings, 'steps')
  const heartRate = latestReading(comparisonReadings, 'heart_rate')
  const sound = latestReading(comparisonReadings, 'sound_level')
  const temperature = latestReading(comparisonReadings, 'temperature')
  const humidity = latestReading(comparisonReadings, 'humidity')
  const light = latestReading(comparisonReadings, 'light')
  const homeSessionTemperature = latestReading(homeSessionReadings, 'temperature')
  const homeSessionHumidity = latestReading(homeSessionReadings, 'humidity')
  const homeSessionLight = latestReading(homeSessionReadings, 'light')
  const environmentTemperature = homeSessionId ? homeSessionTemperature : temperature
  const environmentHumidity = homeSessionId ? homeSessionHumidity : humidity
  const environmentLight = homeSessionId ? homeSessionLight : light
  const homeSessionFreshness = homeSensorFreshness(homeSessionUpdatedAt, homeSessionClock)
  const mood = latestReading(comparisonReadings, 'mood')
  const activityDifference = activity
    ? ((activity.value - effectiveBaseline.normal_activity_level) / effectiveBaseline.normal_activity_level) * 100
    : null
  const stepsDifference = steps && effectiveBaseline.normal_daily_steps
    ? ((steps.value - effectiveBaseline.normal_daily_steps) / effectiveBaseline.normal_daily_steps) * 100
    : null
  const heartRateDifference = heartRate && effectiveBaseline.normal_heart_rate
    ? ((heartRate.value - effectiveBaseline.normal_heart_rate) / effectiveBaseline.normal_heart_rate) * 100
    : null
  const homeConnected = Boolean(homeSessionId) && homeSessionFreshness.state === 'live'

  const connectHomeSensor = () => {
    const code = normalizeDemoCode(demoCodeInput)
    setDemoCodeInput(code)
    if (!isValidDemoCode(code)) {
      setHomeSessionMessage('Demo codes use 6–12 letters or numbers.')
      return
    }
    setHomeSessionReadings([])
    setHomeSessionUpdatedAt(null)
    setHomeSessionSimulated(false)
    setHomeSessionClock(Date.now())
    setHomeSessionMessage(`Looking for Pico W session ${code}…`)
    setHomeSessionId(code)
    setHomeSessionPollKey((current) => current + 1)
  }

  const disconnectHomeSensor = () => {
    setHomeSessionId('')
    setHomeSessionReadings([])
    setHomeSessionUpdatedAt(null)
    setHomeSessionSimulated(false)
    setHomeSessionClock(Date.now())
    setHomeSessionMessage('Disconnected. Readings already imported remain in this browser’s IndexedDB.')
  }

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

  const saveHealthContext = async () => {
    try {
      const saved = await saveClinicalContext(clinicalContext)
      setClinicalContext(saved.notes)
      setClinicalMessage(saved.notes ? 'Health/context notes saved only in this browser.' : 'An empty note was saved locally.')
    } catch {
      setClinicalMessage('Health/context notes could not be saved in this browser.')
    }
  }

  const removeHealthContext = async () => {
    try {
      await deleteClinicalContext()
      setClinicalContext('')
      setClinicalIncludeContext(false)
      setClinicalSummary(null)
      setClinicalMessage('Health/context notes were deleted from this browser.')
    } catch {
      setClinicalMessage('Health/context notes could not be deleted in this browser.')
    }
  }

  const createClinicalSummary = () => {
    if (clinicalStartDate > clinicalEndDate) {
      setClinicalMessage('Choose an end date on or after the start date.')
      return
    }
    if (!clinicalIncludeSleep && !clinicalIncludeActivity && !clinicalIncludeHeartRate) {
      setClinicalMessage('Choose at least one summary topic.')
      return
    }
    const report = generateClinicalSummary({
      options: {
        startDate: clinicalStartDate,
        endDate: clinicalEndDate,
        includeSleep: clinicalIncludeSleep,
        includeActivity: clinicalIncludeActivity,
        includeHeartRate: clinicalIncludeHeartRate,
        includeUserContext: clinicalIncludeContext,
      },
      baseline: effectiveBaseline,
      adaptiveProfile,
      pattern,
      wellnessContext,
      timestamps: {
        sleep: sleep?.timestamp,
        phoneActivity: activity?.timestamp,
        steps: steps?.timestamp,
        heartRate: heartRate?.timestamp,
      },
      userContext: clinicalContext,
    })
    setClinicalSummary(report)
    setClinicalMessage('Preview generated locally. Nothing has been sent or shared.')
  }

  const copyClinicalSummary = async () => {
    if (!clinicalSummary) return
    try {
      await navigator.clipboard.writeText(clinicalSummary.text)
      setClinicalMessage('Summary copied. You decide where to paste it.')
    } catch {
      setClinicalMessage('Clipboard access was unavailable. You can select the preview text or download it instead.')
    }
  }

  const downloadClinicalSummary = () => {
    if (!clinicalSummary) return
    const url = URL.createObjectURL(new Blob([clinicalSummary.text], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `withyou-clinical-summary-${clinicalEndDate}.txt`
    anchor.click()
    URL.revokeObjectURL(url)
    setClinicalMessage('Text summary downloaded locally.')
  }

  const deleteData = async () => {
    if (!window.confirm('Delete all WithYou data stored in this browser? This cannot be undone.')) return
    try {
      const resetBaseline = await clearLocalData()
      setBaseline(resetBaseline)
      setAdaptiveProfile(createAdaptiveProfile(resetBaseline))
      setReadings([])
      setHealthSummaryReadings([])
      setCompanionResult(null)
      setAudioUrl(null)
      setClinicalContext('')
      setClinicalIncludeContext(false)
      setClinicalSummary(null)
      setClinicalMessage('All locally stored notes and generated previews were cleared.')
      setStorageError(null)
      setDemoCodeInput('')
      disconnectHomeSensor()
    } catch {
      setStorageError('Local data could not be deleted in this browser.')
    }
  }

  const activityState = typeof activity?.metadata.state === 'string' ? activity.metadata.state : 'waiting'
  const soundClass = typeof sound?.metadata.classification === 'string' ? sound.metadata.classification : 'not measured'
  const moodLabel = typeof mood?.metadata.label === 'string' ? mood.metadata.label : 'Not checked in'
  const overallBaselineState = adaptiveBaselineState(adaptiveProfile)
  const todayPresentation = buildTodayPresentation({
    hasCurrentData: comparisonReadings.length > 0,
    baselineState: overallBaselineState,
    patternStatus: pattern.status,
    firstReason: pattern.reasons[0],
    missingSourceCount: pattern.missing_sources.length,
  })
  const healthConnected = Boolean(watchHealth.connected || healthSummaryReadings.length)
  const homeRailState = !homeSessionId
    ? 'not_paired'
    : !homeSessionUpdatedAt
      ? 'connecting'
      : homeSessionFreshness.state === 'live' ? 'live' : 'offline'
  const sourceRailItems = buildSourceRailItems({
    phoneConnected: motionStatus === 'connected' || soundStatus === 'connected',
    phoneDetail: motionStatus === 'connected' && soundStatus === 'connected'
      ? 'Motion and sound ready'
      : motionStatus === 'connected' ? 'Motion ready · sound optional' : soundStatus === 'connected' ? 'Sound ready · motion optional' : 'Motion and sound are optional',
    healthConnected,
    healthDetail: healthConnected ? `Last synced ${formatTime(watchHealth.last_reading_at ?? healthSummaryReadings.at(-1)?.timestamp)}` : 'No Health Connect summary yet',
    homeState: homeRailState,
    homeDetail: homeSessionId ? (homeSessionUpdatedAt ? homeSessionFreshness.label : `Pairing ${homeSessionId}`) : 'Connect with a demo code',
    checkInDetail: mood ? `Last check-in ${formatTime(mood.timestamp)}` : 'Sleep and mood are available',
  })
  const baselineRows: BaselineComparisonRow[] = [
    {
      metric: 'Sleep',
      description: 'Latest completed sleep summary',
      signals: [{
        label: 'Sleep duration',
        current: sleep ? `${sleep.value.toFixed(1)} h` : 'No recent summary',
        baseline: adaptiveProfile.metrics.sleep_duration.state === 'learning' ? 'Still learning' : `${effectiveBaseline.normal_sleep_duration.toFixed(1)} h`,
        delta: formatPersonalDelta(sleep?.value ?? null, effectiveBaseline.normal_sleep_duration, adaptiveProfile.metrics.sleep_duration.state, 'h', 1),
        state: adaptiveProfile.metrics.sleep_duration.state,
      }],
    },
    {
      metric: 'Activity',
      description: 'Related evidence, kept as separate source-specific signals',
      signals: [
        {
          label: 'Phone motion',
          current: activity ? `${Math.round(activity.value * 100)}% relative` : 'No recent reading',
          baseline: adaptiveProfile.metrics.phone_motion.state === 'learning' ? 'Still learning' : `${Math.round(effectiveBaseline.normal_activity_level * 100)}% relative`,
          delta: formatPersonalDelta(activity ? activity.value * 100 : null, effectiveBaseline.normal_activity_level * 100, adaptiveProfile.metrics.phone_motion.state, '%', 0),
          state: adaptiveProfile.metrics.phone_motion.state,
        },
        {
          label: 'Health steps',
          current: steps ? Math.round(steps.value).toLocaleString() : 'No recent summary',
          baseline: adaptiveProfile.metrics.steps.state === 'learning' || effectiveBaseline.normal_daily_steps == null ? 'Still learning' : Math.round(effectiveBaseline.normal_daily_steps).toLocaleString(),
          delta: formatPersonalDelta(steps?.value ?? null, effectiveBaseline.normal_daily_steps, adaptiveProfile.metrics.steps.state, 'steps', 0),
          state: adaptiveProfile.metrics.steps.state,
        },
      ],
    },
    {
      metric: 'Heart rate',
      description: 'Recent compact average; observational and non-diagnostic',
      signals: [{
        label: 'Health Connect average',
        current: heartRate ? `${Math.round(heartRate.value)} bpm` : 'No recent summary',
        baseline: adaptiveProfile.metrics.heart_rate.state === 'learning' || effectiveBaseline.normal_heart_rate == null ? 'Still learning' : `${Math.round(effectiveBaseline.normal_heart_rate)} bpm`,
        delta: formatPersonalDelta(heartRate?.value ?? null, effectiveBaseline.normal_heart_rate, adaptiveProfile.metrics.heart_rate.state, 'bpm', 0),
        state: adaptiveProfile.metrics.heart_rate.state,
      }],
    },
  ]
  const conflictingSources = [...new Set(Object.values(adaptiveProfile.last_qualifications)
    .flatMap((qualification) => qualification.conflicting_sources)
    .map(readableSourceName))]
  const sourcePanelTitles: Record<SourceRailId, { title: string; description: string }> = {
    phone: { title: 'Phone sources', description: 'Choose motion and sound-level sensing independently. Both require your permission.' },
    health: { title: 'Health Connect', description: 'Health data is synced by the Android bridge, not directly by this browser.' },
    home: { title: 'Home Sensor', description: 'Pair this browser with the temporary Pico W demo session.' },
    checkins: { title: 'Manual check-ins', description: 'Sleep and mood entries stay in this browser’s local storage.' },
  }

  return (
    <>
      <main className="app-shell">
        <header className="hero" id="home">
          <div className="brand-mark" aria-hidden="true">W</div>
          <div className="hero-copy">
            <p className="eyebrow">Private by design</p>
            <h1>WithYou</h1>
            <p className="tagline">A calm view of your routine, your space, and the sources you choose.</p>
          </div>
          <nav className="top-nav" aria-label="Page sections">
            <a href="#today">Today</a><a href="#environment">Room</a><a href="#clinical-summary">Share</a>
          </nav>
        </header>

        <div className="trust-line"><span aria-hidden="true">●</span> Local-first summaries · supportive, not diagnostic</div>

        <SourceRail items={sourceRailItems} onSelect={setActiveSourcePanel} />

        <section className={`today-hero ${todayPresentation.tone}`} id="today" aria-labelledby="today-heading">
          <div className="today-copy">
            <p className="eyebrow">Today</p>
            <h2 id="today-heading">{todayPresentation.title}</h2>
            <p>{todayPresentation.description}</p>
            <div className="today-actions">
              {pattern.status === 'changed'
                ? <a className="button-link primary" href="#check-in">Check in</a>
                : <button type="button" onClick={() => setActiveSourcePanel('phone')}>{comparisonReadings.length ? 'Manage sources' : 'Choose a source'}</button>}
            </div>
          </div>
          <div className="today-state">
            <span className={`state-badge ${overallBaselineState}`}>{overallBaselineState}</span>
            <strong>{pattern.activity_fusion.confidence === 'none' ? 'Available data only' : `${pattern.activity_fusion.confidence} confidence`}</strong>
            <small>{pattern.supporting_sources.length ? `${pattern.supporting_sources.length} supporting source${pattern.supporting_sources.length === 1 ? '' : 's'}` : 'No movement source yet'}</small>
          </div>
        </section>

        <section className={`support-section ${pattern.status === 'changed' ? 'prominent' : 'quiet'}`} id="check-in" aria-labelledby="check-in-heading">
          <div className="section-intro compact-intro">
            <div><p className="eyebrow">A moment for you</p><h2 id="check-in-heading">{pattern.status === 'changed' ? 'A few parts of your routine shifted. How are you feeling today?' : 'How are you feeling today?'}</h2></div>
            {mood && <span className="state-badge qualified">Checked in · {moodLabel}</span>}
          </div>
          <div className="mood-buttons">
            {Object.keys(MOOD_SCORES).map((label) => <button key={label} onClick={() => checkInMood(label)}>{label}</button>)}
          </div>
          <div className="inline-input"><input aria-label="Add optional check-in context" value={customMood} maxLength={160} placeholder="Add a little context…" onChange={(event) => setCustomMood(event.target.value)} /><button onClick={() => customMood.trim() && checkInMood('custom', customMood.trim())}>Save locally</button></div>
          <div className="support-actions">
            {!recording ? <button type="button" onClick={() => void startVoice()} disabled={companionBusy}>Talk to WithYou <span aria-hidden="true">🎙️</span></button> : <button type="button" className="recording-button" onClick={stopVoice}>Stop recording</button>}
            <span>{voiceMessage || 'Mood is voluntary and never inferred from sound.'}</span>
          </div>
          <details className="inline-disclosure">
            <summary>Write a message to WithYou</summary>
            <div className="chat-input-row">
              <textarea aria-label="Message WithYou" value={companionInput} maxLength={1000} placeholder="Tell WithYou how today is going…" onChange={(event) => setCompanionInput(event.target.value)} />
              <button className="primary" onClick={() => void sendTypedMessage()} disabled={companionBusy || !companionInput.trim()}>Send</button>
            </div>
          </details>
          {companionResult && <div className="conversation">
            {companionResult.transcript && <div><span>You said</span><p>{companionResult.transcript}</p></div>}
            <div><span>WithYou {companionResult.used_ai ? '· AI response' : '· safe local response'}</span><p>{companionResult.text}</p></div>
            {audioUrl && <div><span>AI-generated voice</span><audio controls src={audioUrl}>Spoken response</audio></div>}
          </div>}
          <p className="microcopy">Only your message and the compact interpreted summary are sent for a response—not your full local history.</p>
        </section>

        <BaselineComparison rows={baselineRows} />

        <section className="evidence-section" aria-labelledby="evidence-heading">
          <div className="section-intro compact-intro">
            <div><p className="eyebrow">Plain-language evidence</p><h2 id="evidence-heading">Why WithYou noticed this</h2></div>
            <span className={`state-badge ${pattern.activity_fusion.interpretation === 'mixed' ? 'adapting' : pattern.status === 'changed' ? 'learning' : 'qualified'}`}>
              {pattern.activity_fusion.confidence === 'none' ? 'Limited evidence' : `${pattern.activity_fusion.confidence} confidence`}
            </span>
          </div>
          <p className="evidence-lead">{pattern.activity_fusion.note}</p>
          <p className="evidence-context">Home Sensor readings add room context only and never substitute for phone or Health movement data.</p>
          <details className="inline-disclosure evidence-details">
            <summary>See source details</summary>
            <dl className="evidence-list">
              <div><dt>Supporting</dt><dd>{pattern.supporting_sources.length ? pattern.supporting_sources.map(readableSourceName).join(', ') : 'None available yet'}</dd></div>
              <div><dt>Conflicting</dt><dd>{conflictingSources.length ? conflictingSources.join(', ') : pattern.activity_fusion.interpretation === 'mixed' ? 'Phone motion, Health steps' : 'None identified'}</dd></div>
              <div><dt>Missing</dt><dd>{pattern.missing_sources.length ? pattern.missing_sources.map(readableSourceName).join(', ') : 'None'}</dd></div>
              <div><dt>Baseline</dt><dd>{overallBaselineState === 'learning' ? 'Still learning your routine' : overallBaselineState === 'adapting' ? 'Learning a repeated routine change gradually' : 'Qualified rolling baselines available'}</dd></div>
            </dl>
            <p className="microcopy">Missing sources are ignored, not treated as unusual values.</p>
          </details>
        </section>

        <div className="lower-story-grid">
          <section className="environment-section" id="environment" aria-labelledby="environment-heading">
            <div className="section-intro compact-intro">
              <div><p className="eyebrow">Your space</p><h2 id="environment-heading">Room environment</h2></div>
              <span className={`status-label ${homeSessionId && homeSessionFreshness.state === 'live' ? 'live' : homeSessionUpdatedAt ? 'offline' : 'muted'}`}>{homeSessionId && homeSessionUpdatedAt ? homeSessionFreshness.label : homeSessionId ? 'Waiting for a Pico reading' : 'Not paired'}</span>
            </div>
            <div className="environment-summary">
              <span className={homeSessionId && homeSessionFreshness.state === 'offline' ? 'stale-reading' : ''}>Temperature <strong>{environmentTemperature ? `${environmentTemperature.value} °F` : '—'}</strong><small>{homeSessionId ? homeSensorValueLabel(homeSessionFreshness, Boolean(environmentTemperature)) : environmentTemperature ? environmentTemperature.is_simulated ? 'Saved simulated value' : 'Saved local value' : 'No reading'}</small></span>
              <span className={homeSessionId && homeSessionFreshness.state === 'offline' ? 'stale-reading' : ''}>Humidity <strong>{environmentHumidity ? `${environmentHumidity.value}%` : '—'}</strong><small>{homeSessionId ? homeSensorValueLabel(homeSessionFreshness, Boolean(environmentHumidity)) : environmentHumidity ? environmentHumidity.is_simulated ? 'Saved simulated value' : 'Saved local value' : 'No reading'}</small></span>
              <span className={homeSessionId && homeSessionFreshness.state === 'offline' ? 'stale-reading' : ''}>Light <strong>{environmentLight ? `${environmentLight.value} lux` : '—'}</strong><small>{homeSessionId ? homeSensorValueLabel(homeSessionFreshness, Boolean(environmentLight)) : environmentLight ? environmentLight.is_simulated ? 'Saved simulated value' : 'Saved local value' : 'No reading'}</small></span>
            </div>
            {homeSessionId && homeSessionSimulated && <p className="simulation-disclosure"><strong>Demo disclosure:</strong> Environmental values are simulated; the Pico W, Wi-Fi, HTTPS request, and backend connection are live.</p>}
            <button type="button" onClick={() => setActiveSourcePanel('home')}>{homeSessionId ? 'Manage Home Sensor' : 'Connect Home Sensor'}</button>
          </section>

          <section className="summary-cta" id="clinical-summary" aria-labelledby="clinical-summary-heading">
            <p className="eyebrow">Share only when you choose</p>
            <h2 id="clinical-summary-heading">Clinical / caregiver summary</h2>
            <p>Create a concise, non-diagnostic summary of recent routine changes, confidence, and supporting sources.</p>
            <p className="summary-safety">{CLINICAL_SUMMARY_DISCLAIMER}</p>
            <button className="primary" type="button" onClick={() => setClinicalPanelOpen(true)}>Generate clinical summary</button>
          </section>
        </div>

        <section className="secondary-zone" aria-labelledby="secondary-heading">
          <div className="section-intro"><div><p className="eyebrow">Optional tools</p><h2 id="secondary-heading">Demo, learning, and privacy</h2></div><p>Available when you need them, out of the main daily flow.</p></div>
          <details className="utility-disclosure">
            <summary>Demo controls <span>Simulated values only</span></summary>
            <div className="utility-content">
              <h3>Complete-day scenarios</h3>
              <div className="demo-buttons">
                <button onClick={() => runDemo('normal')}>Normal Day</button><button onClick={() => runDemo('low')}>Low Activity</button>
                <button onClick={() => runDemo('sleep')}>Poor Sleep</button><button onClick={() => runDemo('stress')}>Stress Check-In</button>
                <button onClick={() => runDemo('loud')}>Loud Environment</button><button onClick={() => runDemo('warm')}>Warm Room</button>
                <button className="accent-button" onClick={() => runDemo('combined')}>Combined Different Day</button>
              </div>
              <h3>Individual phone and room values</h3>
              <div className="demo-buttons">
                <button onClick={() => addDemoActivity('still')}>Sitting Still</button><button onClick={() => addDemoActivity('walking')}>Walking</button><button onClick={() => addDemoActivity('active')}>Active</button><button onClick={() => addDemoActivity('sleeping')}>Sleeping</button>
                <button onClick={() => void recordSensor(soundReading('quiet', 0.08))}>Quiet Sound</button><button onClick={() => void recordSensor(soundReading('normal', 0.42))}>Normal Sound</button><button onClick={() => void recordSensor(soundReading('loud', 0.86))}>Loud Sound</button>
                <button onClick={() => void recordSensors([environmentReading('temperature', 72, 'fahrenheit', 'normal room'), environmentReading('humidity', 45, 'percent', 'normal room'), environmentReading('light', 400, 'lux', 'normal room')])}>Normal Room</button>
                <button onClick={() => void recordSensor(environmentReading('temperature', 83, 'fahrenheit', 'warm room'))}>Warm Room</button><button onClick={() => void recordSensor(environmentReading('temperature', 63, 'fahrenheit', 'cool room'))}>Cool Room</button><button onClick={() => void recordSensor(environmentReading('light', 35, 'lux', 'low light'))}>Low Light</button><button onClick={() => void recordSensor(environmentReading('humidity', 78, 'percent', 'high humidity'))}>High Humidity</button>
              </div>
            </div>
          </details>
          <details className="utility-disclosure">
            <summary>How personal baselines work <span>{overallBaselineState}</span></summary>
            <div className="utility-content privacy-copy">
              <p>WithYou learns separate source-specific baselines and adapts only after a repeated, qualified pattern.</p>
              <p>Missing sources are ignored. Phone motion and Health steps remain different signals, and room readings provide context only.</p>
            </div>
          </details>
          <details className="utility-disclosure">
            <summary>Privacy and reset <span>Local-first</span></summary>
            <div className="utility-content privacy-reset-row">
              <div className="privacy-copy">
                <p>WithYou notices changes in patterns. It does not diagnose conditions.</p>
                <p>Raw wellness history stays on your device whenever possible.</p>
                <p>Sound sensing measures amplitude only and never saves conversations.</p>
              </div>
              <button className="danger-button" onClick={() => void deleteData()}>Delete My Local Data</button>
            </div>
          </details>
        </section>

        {storageError && <p className="error floating-error" role="alert">{storageError}</p>}
      </main>

      <OverlayPanel
        open={activeSourcePanel != null}
        title={sourcePanelTitles[activeSourcePanel ?? 'phone'].title}
        description={sourcePanelTitles[activeSourcePanel ?? 'phone'].description}
        onClose={() => setActiveSourcePanel(null)}
      >
        {activeSourcePanel === 'phone' && <div className="panel-stack">
          <section><div className="panel-section-heading"><div><p className="eyebrow">Phone motion</p><h3>Movement summaries</h3></div><span className={`status-label ${motionStatus === 'connected' ? 'live' : 'muted'}`}>{motionStatus === 'connected' ? 'Connected' : 'Permission required'}</span></div>
            <div className="primary-controls"><button className="primary" onClick={() => void handleStartMotion()} disabled={motionStatus === 'starting' || motionStatus === 'connected'}>Start motion</button><button onClick={handleStopMotion} disabled={!sessionRef.current}>Stop</button></div>
            <p className={`sensor-message ${motionStatus === 'unavailable' ? 'warning' : ''}`}>{motionMessage}</p>
          </section>
          <section><div className="panel-section-heading"><div><p className="eyebrow">Phone microphone</p><h3>Environmental sound level</h3></div><span className={`status-label ${soundStatus === 'connected' ? 'live' : 'muted'}`}>{soundStatus === 'connected' ? 'Ready' : 'Permission required'}</span></div>
            <button className="primary" onClick={() => void handleMeasureSound()} disabled={soundStatus === 'measuring'}>{soundStatus === 'measuring' ? 'Measuring…' : 'Measure sound level'}</button>
            <p className={`sensor-message ${soundStatus === 'unavailable' ? 'warning' : ''}`}>{soundMessage}</p>
            <p className="microcopy">Amplitude only. No recording, transcription, or conversation analysis.</p>
          </section>
        </div>}
        {activeSourcePanel === 'health' && <div className="panel-stack"><section className="source-detail-empty"><span className={`status-label ${healthConnected ? 'live' : 'muted'}`}>{healthConnected ? 'Connected via Health Connect' : 'Not connected'}</span><h3>{healthConnected ? 'Compact summaries are available' : 'Health data has not synced yet'}</h3><p>{healthConnected ? `Last synced ${formatTime(watchHealth.last_reading_at ?? healthSummaryReadings.at(-1)?.timestamp)}. WithYou receives current and baseline summaries only.` : 'Use the WithYou Android Health Bridge to grant read-only access and manually sync. This browser cannot request native Health Connect permissions.'}</p></section></div>}
        {activeSourcePanel === 'home' && <div className="panel-stack"><section>
          <div className="panel-section-heading"><div><p className="eyebrow">Pico W demo session</p><h3>{homeSessionId ? 'Manage connection' : 'Connect Home Sensor'}</h3></div><span className={`status-label ${homeConnected ? 'live' : homeSessionUpdatedAt ? 'offline' : 'muted'}`}>{homeSessionId && homeSessionUpdatedAt ? homeSessionFreshness.label : homeSessionId ? 'Connecting' : 'Not paired'}</span></div>
          <form className="pairing-row" onSubmit={(event) => { event.preventDefault(); connectHomeSensor() }}>
            <label>Demo code<input aria-label="Home sensor demo code" value={demoCodeInput} maxLength={12} autoCapitalize="characters" autoComplete="off" placeholder="WITHYOU1" onChange={(event) => setDemoCodeInput(normalizeDemoCode(event.target.value))} /></label>
            <button className="primary" type="submit">Connect</button>
            {homeSessionId && <button type="button" onClick={disconnectHomeSensor}>Disconnect</button>}
          </form>
          <p className={`sensor-message ${homeSessionId && homeSessionFreshness.state !== 'live' ? 'warning' : ''}`}>{homeSessionId && homeSessionUpdatedAt ? homeSessionFreshness.label : homeSessionMessage}</p>
          <p className="microcopy">No account is required. Latest values are copied into this browser’s IndexedDB.</p>
        </section></div>}
        {activeSourcePanel === 'checkins' && <div className="panel-stack"><section>
          <div className="panel-section-heading"><div><p className="eyebrow">Manual entry</p><h3>Completed sleep</h3></div><span className="status-label live">Available</span></div>
          <div className="field-grid"><label>Sleep start<input type="datetime-local" value={sleepStart} onChange={(event) => setSleepStart(event.target.value)} /></label><label>Wake time<input type="datetime-local" value={wakeTime} onChange={(event) => setWakeTime(event.target.value)} /></label></div>
          <button className="primary" onClick={() => void saveSleep()}>Save sleep locally</button>
          <p className="sensor-message">{sleepMessage || 'Manual sleep stays available even when Health Connect is not connected.'}</p>
          <p className="microcopy">Mood check-ins remain in the Today section so they are easy to reach.</p>
        </section></div>}
      </OverlayPanel>

      <OverlayPanel open={clinicalPanelOpen} title="Clinical / caregiver summary" description="Configure and preview a concise local report. Nothing is sent automatically." wide onClose={() => setClinicalPanelOpen(false)}>
        <div className="clinical-summary-card">
          <p className="clinical-disclaimer"><strong>{CLINICAL_SUMMARY_DISCLAIMER}</strong></p>
          <div className="clinical-summary-settings">
            <fieldset><legend>Date range</legend><div className="field-grid"><label>Start date<input type="date" value={clinicalStartDate} max={clinicalEndDate} onChange={(event) => setClinicalStartDate(event.target.value)} /></label><label>End date<input type="date" value={clinicalEndDate} min={clinicalStartDate} max={localDateValue(new Date())} onChange={(event) => setClinicalEndDate(event.target.value)} /></label></div></fieldset>
            <fieldset><legend>Include</legend><div className="clinical-options"><label><input type="checkbox" checked={clinicalIncludeSleep} onChange={(event) => setClinicalIncludeSleep(event.target.checked)} /> Sleep</label><label><input type="checkbox" checked={clinicalIncludeActivity} onChange={(event) => setClinicalIncludeActivity(event.target.checked)} /> Activity</label><label><input type="checkbox" checked={clinicalIncludeHeartRate} onChange={(event) => setClinicalIncludeHeartRate(event.target.checked)} /> Heart rate</label><label><input type="checkbox" checked={clinicalIncludeContext} disabled={!clinicalContext.trim()} onChange={(event) => setClinicalIncludeContext(event.target.checked)} /> My context notes</label></div></fieldset>
          </div>
          <details className="inline-disclosure"><summary>Optional health/context notes</summary><div className="clinical-context-editor"><label>Health/context notes<textarea value={clinicalContext} maxLength={2000} placeholder="Examples: night-shift schedule, mobility limitations, medications that may affect sleep or heart rate, or a clinician-provided normal range." onChange={(event) => setClinicalContext(event.target.value)} /></label><div className="primary-controls"><button type="button" onClick={() => void saveHealthContext()}>Remember locally</button><button type="button" className="danger-button" onClick={() => void removeHealthContext()} disabled={!clinicalContext}>Delete notes</button></div><p className="microcopy">Included only when “My context notes” is checked.</p></div></details>
          <button className="primary clinical-generate-button" type="button" onClick={createClinicalSummary}>Generate summary</button>
          <p className="sensor-message" role="status">{clinicalMessage}</p>
          {clinicalSummary && <><article className="clinical-summary-preview" aria-label="Clinical summary preview"><p className="eyebrow">Preview</p><h2>{clinicalSummary.title}</h2><p className="clinical-disclaimer"><strong>{clinicalSummary.disclaimer}</strong></p><dl className="clinical-summary-meta"><div><dt>Date range</dt><dd>{clinicalSummary.dateRange}</dd></div><div><dt>Generated</dt><dd>{new Date(clinicalSummary.generatedAt).toLocaleString()}</dd></div></dl>{clinicalSummary.sections.map((section) => <section key={section.heading}><h3>{section.heading}</h3><ul>{section.lines.map((line, index) => <li key={`${section.heading}-${index}`}>{line}</li>)}</ul></section>)}</article><div className="clinical-summary-actions"><button type="button" onClick={() => void copyClinicalSummary()}>Copy summary</button><button type="button" onClick={downloadClinicalSummary}>Download text</button><button type="button" onClick={() => window.print()}>Print / Save as PDF</button></div></>}
        </div>
      </OverlayPanel>
    </>
  )
}
