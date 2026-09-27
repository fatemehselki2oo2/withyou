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
  HEALTH_HELPER_APK_URL,
  HEALTH_HELPER_GITHUB_APK_URL,
  HEALTH_HELPER_INSTALL_HELP_URL,
  HEALTH_HELPER_RELEASE_URL,
  healthBridgeIntentUrl,
  healthBridgeReturnState,
} from './healthBridge'
import {
  applyHealthConnectBaselines,
  currentHealthReadings,
  selectHealthConnectSummaries,
} from './healthSummarySelection'
import { startMotionSession, type MotionFailureReason, type MotionSession } from './motion'
import { platformInfo } from './platform'
import { analyzePatterns, buildWellnessContext, latestReading } from './patternAnalyzer'
import { canUseVoiceInput, requestVoiceInputStream } from './voiceInput'
import {
  applySelectedDemoScenario,
  demoPresentationBaseline,
  DEMO_SCENARIOS,
  EMPTY_DEMO_SCENARIO_STATE,
  readingsForRealLearning,
  selectDemoScenario,
  type DemoScenarioId,
} from './demoScenarios'
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
  healthPanelVisibility,
  readableSourceName,
  type SourceRailId,
} from './uiPresentation'
import type {
  ActivityReading,
  BaselineProfile,
  CompanionResult,
  SensorReading,
} from './types'
import './styles.css'

type PhoneStatus = 'permission_needed' | 'connecting' | 'connected' | 'unavailable'
type ExternalSourceHealth = {
  connected?: boolean
  last_reading_at?: string | null
  last_sensor_type?: string | null
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
  const healthBridgeReturn = useMemo(() => healthBridgeReturnState(window.location.search), [])
  const healthBridgeLink = useMemo(() => healthBridgeIntentUrl(window.location.href), [])
  const platform = useMemo(() => platformInfo(navigator), [])
  const [baseline, setBaseline] = useState<BaselineProfile>(DEMO_BASELINE)
  const [adaptiveProfile, setAdaptiveProfile] = useState(() => createAdaptiveProfile(DEMO_BASELINE))
  const [adaptiveLoaded, setAdaptiveLoaded] = useState(false)
  const [readings, setReadings] = useState<SensorReading[]>([])
  const [demoScenario, setDemoScenario] = useState(EMPTY_DEMO_SCENARIO_STATE)
  const [motionStatus, setMotionStatus] = useState<PhoneStatus>('permission_needed')
  const [motionMessage, setMotionMessage] = useState('Connect Phone to use motion while WithYou is open.')
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
  const [healthRefreshKey, setHealthRefreshKey] = useState(0)
  const [healthGuideStarted, setHealthGuideStarted] = useState(healthBridgeReturn != null)
  const [healthInstallStarted, setHealthInstallStarted] = useState(false)
  const [healthBridgeMessage, setHealthBridgeMessage] = useState(() => {
    if (healthBridgeReturn === 'not_installed') {
      return 'To connect your health data, install the WithYou Health Helper.'
    }
    if (healthBridgeReturn === 'sync_complete') {
      return 'Health sync finished. WithYou is checking for your compact summaries now.'
    }
    return ''
  })
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
  const phoneAutoResumeRef = useRef(false)
  const resumePhoneRef = useRef<() => void>(() => undefined)
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
    const pauseWhenHidden = () => {
      if (document.visibilityState === 'hidden') {
        sessionRef.current?.stop()
        sessionRef.current = null
        return
      }
      resumePhoneRef.current()
      setHealthRefreshKey((value) => value + 1)
    }
    const resumeWhenFocused = () => {
      resumePhoneRef.current()
      setHealthRefreshKey((value) => value + 1)
    }
    document.addEventListener('visibilitychange', pauseWhenHidden)
    window.addEventListener('focus', resumeWhenFocused)
    window.addEventListener('pageshow', resumeWhenFocused)
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden)
      window.removeEventListener('focus', resumeWhenFocused)
      window.removeEventListener('pageshow', resumeWhenFocused)
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
  }, [healthRefreshKey])

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
    () => analyzePatterns(comparisonReadings, effectiveBaseline, adaptiveProfile),
    [comparisonReadings, effectiveBaseline, adaptiveProfile],
  )
  const activeDemo = demoScenario.applied
  const presentationBaseline = useMemo(
    () => activeDemo ? demoPresentationBaseline(effectiveBaseline) : effectiveBaseline,
    [activeDemo, effectiveBaseline],
  )
  const presentationReadings = useMemo(
    () => activeDemo ? [...comparisonReadings, ...activeDemo.readings] : comparisonReadings,
    [activeDemo, comparisonReadings],
  )
  const presentationPattern = useMemo(
    () => activeDemo ? analyzePatterns(activeDemo.readings, presentationBaseline) : pattern,
    [activeDemo, pattern, presentationBaseline],
  )
  const learning = useMemo(
    () => buildLearningInputs(readingsForRealLearning(presentationReadings), selectedHealthSummaries, pattern.activity_fusion),
    [pattern.activity_fusion, presentationReadings, selectedHealthSummaries],
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
  const realActivity = latestReading(comparisonReadings, 'activity')
  const realSleep = latestReading(comparisonReadings, 'sleep')
  const realSteps = latestReading(comparisonReadings, 'steps')
  const realHeartRate = latestReading(comparisonReadings, 'heart_rate')
  const activity = latestReading(presentationReadings, 'activity')
  const sleep = latestReading(presentationReadings, 'sleep')
  const steps = latestReading(presentationReadings, 'steps')
  const heartRate = latestReading(presentationReadings, 'heart_rate')
  const temperature = latestReading(presentationReadings, 'temperature')
  const humidity = latestReading(presentationReadings, 'humidity')
  const light = latestReading(presentationReadings, 'light')
  const homeSessionTemperature = latestReading(homeSessionReadings, 'temperature')
  const homeSessionHumidity = latestReading(homeSessionReadings, 'humidity')
  const homeSessionLight = latestReading(homeSessionReadings, 'light')
  const demoTemperature = activeDemo ? latestReading(activeDemo.readings, 'temperature') : undefined
  const demoHumidity = activeDemo ? latestReading(activeDemo.readings, 'humidity') : undefined
  const demoLight = activeDemo ? latestReading(activeDemo.readings, 'light') : undefined
  const environmentTemperature = demoTemperature ?? (homeSessionId ? homeSessionTemperature : temperature)
  const environmentHumidity = demoHumidity ?? (homeSessionId ? homeSessionHumidity : humidity)
  const environmentLight = demoLight ?? (homeSessionId ? homeSessionLight : light)
  const homeSessionFreshness = homeSensorFreshness(homeSessionUpdatedAt, homeSessionClock)
  const mood = latestReading(comparisonReadings, 'mood')
  const activityDifference = activity
    ? ((activity.value - presentationBaseline.normal_activity_level) / presentationBaseline.normal_activity_level) * 100
    : null
  const stepsDifference = steps && presentationBaseline.normal_daily_steps
    ? ((steps.value - presentationBaseline.normal_daily_steps) / presentationBaseline.normal_daily_steps) * 100
    : null
  const heartRateDifference = heartRate && presentationBaseline.normal_heart_rate
    ? ((heartRate.value - presentationBaseline.normal_heart_rate) / presentationBaseline.normal_heart_rate) * 100
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

  const recordActivity = async (reading: ActivityReading) => {
    await Promise.all([recordSensor(activitySensor(reading)), saveReading(reading)])
  }

  const startPhoneMotion = async (requestPermission: boolean) => {
    if (sessionRef.current) return
    setMotionStatus('connecting')
    setMotionMessage(requestPermission ? 'Requesting motion permission…' : 'Resuming phone motion…')
    try {
      const session = await startMotionSession(
        (reading) => {
          setMotionStatus('connected')
          setMotionMessage('Connected · updating automatically while WithYou is open.')
          void recordActivity(reading)
        },
        (reason: MotionFailureReason, message) => {
          setMotionStatus(reason === 'permission_denied' ? 'permission_needed' : 'unavailable')
          setMotionMessage(message)
          sessionRef.current = null
          phoneAutoResumeRef.current = false
        },
        { requestPermission },
      )
      sessionRef.current = session
      phoneAutoResumeRef.current = Boolean(session)
      if (session) setMotionMessage('Connected · waiting for the first motion update…')
    } catch {
      setMotionStatus('permission_needed')
      setMotionMessage('Motion permission is needed to connect this phone.')
      phoneAutoResumeRef.current = false
    }
  }

  const handleConnectPhone = () => void startPhoneMotion(true)
  resumePhoneRef.current = () => {
    if (phoneAutoResumeRef.current && !sessionRef.current && document.visibilityState === 'visible') {
      void startPhoneMotion(false)
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

  const chooseDemoScenario = (scenario: DemoScenarioId) => {
    setDemoScenario((current) => selectDemoScenario(current, scenario))
  }

  const runSelectedDemoScenario = () => {
    setDemoScenario((current) => applySelectedDemoScenario(current))
  }

  const clearDemoScenario = () => setDemoScenario(EMPTY_DEMO_SCENARIO_STATE)

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
      setAudioUrl(result.audio_base64 && result.audio_mime_type
        ? `data:${result.audio_mime_type};base64,${result.audio_base64}`
        : null)
      setVoiceMessage(result.audio_available
        ? 'Response ready. The playback voice is AI-generated.'
        : 'Text response ready; spoken playback was unavailable.')
    } catch {
      setCompanionResult(safeLocalCompanion(pattern.reasons))
      setVoiceMessage('Voice processing was unavailable. Typed chat still works.')
    } finally {
      audioChunksRef.current = []
      setCompanionBusy(false)
    }
  }

  const startVoice = async () => {
    if (!canUseVoiceInput()) {
      setVoiceMessage('Voice input is unavailable here. Typed chat still works.')
      return
    }
    try {
      // This user-initiated action is the only microphone request in the app.
      // Audio is sent to the companion endpoint and never becomes sensor data.
      const stream = await requestVoiceInputStream()
      const preferred = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
        .find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream)
      audioChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        const baseType = recorder.mimeType.split(';')[0] || 'audio/webm'
        void submitVoice(new Blob(audioChunksRef.current, { type: baseType }))
      }
      recorder.start()
      mediaRecorderRef.current = recorder
      setRecording(true)
      setVoiceMessage('Recording… Tap Stop when you’re finished.')
    } catch {
      setVoiceMessage('Microphone permission was not granted. Typed chat still works.')
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
        sleep: realSleep?.timestamp,
        phoneActivity: realActivity?.timestamp,
        steps: realSteps?.timestamp,
        heartRate: realHeartRate?.timestamp,
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
  const moodLabel = typeof mood?.metadata.label === 'string' ? mood.metadata.label : 'Not checked in'
  const overallBaselineState = adaptiveBaselineState(adaptiveProfile)
  const presentationBaselineState = activeDemo ? 'qualified' : overallBaselineState
  const baseTodayPresentation = buildTodayPresentation({
    hasCurrentData: presentationReadings.length > 0,
    baselineState: presentationBaselineState,
    patternStatus: presentationPattern.status,
    firstReason: presentationPattern.reasons[0],
    missingSourceCount: presentationPattern.missing_sources.length,
  })
  const todayPresentation = activeDemo ? {
    ...baseTodayPresentation,
    title: presentationPattern.status === 'changed'
      ? 'Simulated meaningful-change scenario'
      : 'Simulated normal-day scenario',
    description: baseTodayPresentation.description,
  } : baseTodayPresentation
  const currentHealthMetrics = selectedHealthSummaries.current
  const healthCurrentCount = Object.values(currentHealthMetrics).filter(Boolean).length
  const healthLastSyncedAt = healthSummaryReadings.reduce<string | undefined>((latest, reading) => (
    !latest || new Date(reading.timestamp) > new Date(latest) ? reading.timestamp : latest
  ), watchHealth.last_reading_at ?? undefined)
  const healthState = healthCurrentCount > 0 ? 'connected' : watchHealth.connected ? 'sync_needed' : 'not_connected'
  const healthPanel = healthPanelVisibility({
    healthState,
    isAndroid: platform.isAndroid,
    isDesktop: platform.isDesktop,
    helperMissing: healthBridgeReturn === 'not_installed',
  })
  const phoneState = motionStatus === 'connected'
    ? 'connected'
    : motionStatus === 'unavailable' ? 'unavailable' : 'permission_needed'
  const homeRailState = !homeSessionId
    ? 'not_paired'
    : !homeSessionUpdatedAt
      ? 'connecting'
      : homeSessionFreshness.state === 'live' ? 'live' : 'offline'
  const sourceRailItems = buildSourceRailItems({
    phoneState,
    phoneDetail: motionStatus === 'connected'
      ? 'Updating motion automatically'
      : motionStatus === 'unavailable' ? 'Motion is unavailable here' : 'Tap to connect motion',
    healthState,
    healthDetail: healthState === 'connected'
      ? `Last synced ${formatTime(healthLastSyncedAt)}`
      : healthState === 'sync_needed' ? 'Open WithYou Health Helper to sync' : 'Connect on a supported Android phone',
    homeState: homeRailState,
    homeDetail: homeSessionId ? (homeSessionUpdatedAt ? homeSessionFreshness.label : `Pairing ${homeSessionId}`) : 'Connect with a demo code',
    checkInDetail: mood ? `Last check-in ${formatTime(mood.timestamp)}` : 'Sleep and mood are available',
  }).map((item) => {
    if (!platform.isDesktop) return item
    if (item.id === 'phone') {
      return realActivity
        ? { ...item, state: 'Summary available', detail: `Latest mobile summary ${formatTime(realActivity.timestamp)}`, tone: 'connected' as const }
        : { ...item, state: 'Mobile source', detail: 'Connect activity from your phone', tone: 'muted' as const }
    }
    if (item.id === 'health' && healthState !== 'connected') {
      return { ...item, state: healthState === 'sync_needed' ? 'Sync on mobile' : 'Mobile setup', detail: 'Connect Health from Android', tone: healthState === 'sync_needed' ? 'attention' as const : 'muted' as const }
    }
    return item
  })
  const baselineRows: BaselineComparisonRow[] = [
    {
      metric: 'Sleep',
      description: 'Latest completed sleep summary',
      signals: [{
        label: 'Sleep duration',
        current: sleep ? `${sleep.value.toFixed(1)} h` : 'No recent summary',
        baseline: !activeDemo && adaptiveProfile.metrics.sleep_duration.state === 'learning' ? 'Still learning' : `${presentationBaseline.normal_sleep_duration.toFixed(1)} h`,
        delta: formatPersonalDelta(sleep?.value ?? null, presentationBaseline.normal_sleep_duration, activeDemo ? 'qualified' : adaptiveProfile.metrics.sleep_duration.state, 'h', 1),
        state: activeDemo ? 'qualified' : adaptiveProfile.metrics.sleep_duration.state,
      }],
    },
    {
      metric: 'Activity',
      description: 'Related evidence, kept as separate source-specific signals',
      signals: [
        {
          label: 'Phone motion',
          current: activity ? `${Math.round(activity.value * 100)}% relative` : 'No recent reading',
          baseline: !activeDemo && adaptiveProfile.metrics.phone_motion.state === 'learning' ? 'Still learning' : `${Math.round(presentationBaseline.normal_activity_level * 100)}% relative`,
          delta: formatPersonalDelta(activity ? activity.value * 100 : null, presentationBaseline.normal_activity_level * 100, activeDemo ? 'qualified' : adaptiveProfile.metrics.phone_motion.state, '%', 0),
          state: activeDemo ? 'qualified' : adaptiveProfile.metrics.phone_motion.state,
        },
        {
          label: 'Health steps',
          current: steps ? Math.round(steps.value).toLocaleString() : 'No recent summary',
          baseline: (!activeDemo && adaptiveProfile.metrics.steps.state === 'learning') || presentationBaseline.normal_daily_steps == null ? 'Still learning' : Math.round(presentationBaseline.normal_daily_steps).toLocaleString(),
          delta: formatPersonalDelta(steps?.value ?? null, presentationBaseline.normal_daily_steps, activeDemo ? 'qualified' : adaptiveProfile.metrics.steps.state, 'steps', 0),
          state: activeDemo ? 'qualified' : adaptiveProfile.metrics.steps.state,
        },
      ],
    },
    {
      metric: 'Heart rate',
      description: 'Recent compact average; observational and non-diagnostic',
      signals: [{
        label: 'Health Connect average',
        current: heartRate ? `${Math.round(heartRate.value)} bpm` : 'No recent summary',
        baseline: (!activeDemo && adaptiveProfile.metrics.heart_rate.state === 'learning') || presentationBaseline.normal_heart_rate == null ? 'Still learning' : `${Math.round(presentationBaseline.normal_heart_rate)} bpm`,
        delta: formatPersonalDelta(heartRate?.value ?? null, presentationBaseline.normal_heart_rate, activeDemo ? 'qualified' : adaptiveProfile.metrics.heart_rate.state, 'bpm', 0),
        state: activeDemo ? 'qualified' : adaptiveProfile.metrics.heart_rate.state,
      }],
    },
  ]
  const conflictingSources = [...new Set(Object.values(adaptiveProfile.last_qualifications)
    .flatMap((qualification) => qualification.conflicting_sources)
    .map(readableSourceName))]
  const presentationConflictingSources = activeDemo ? [] : conflictingSources
  const sourcePanelTitles: Record<SourceRailId, { title: string; description: string }> = {
    phone: platform.isDesktop
      ? { title: 'Phone activity summaries', description: 'View mobile activity evidence without using this computer as a motion sensor.' }
      : { title: 'Connect Phone', description: 'Use motion to summarize activity while WithYou is open.' },
    health: platform.isDesktop
      ? { title: 'Health summaries', description: 'View compact Health Connect summaries synced from an Android phone.' }
      : { title: 'Connect Health', description: 'Bring in compact steps, sleep, and heart-rate summaries from Health Connect.' },
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
            <p className="eyebrow">{activeDemo ? 'Demo Simulation · simulated values only' : 'Today'}</p>
            <h2 id="today-heading">{todayPresentation.title}</h2>
            <p>{todayPresentation.description}</p>
            {activeDemo && <p className="demo-alert-disclosure"><strong>Simulated Scenario:</strong> {activeDemo.label}. This is a temporary presentation preview—not a real alert, observation, or baseline event.</p>}
            <div className="today-actions">
              {presentationPattern.status === 'changed'
                ? <a className="button-link primary" href="#check-in">Check in</a>
                : <button type="button" onClick={() => setActiveSourcePanel('phone')}>{presentationReadings.length ? 'Manage sources' : 'Choose a source'}</button>}
              {activeDemo && <button type="button" onClick={clearDemoScenario}>Exit Demo</button>}
            </div>
          </div>
          <div className="today-state">
            <span className={`state-badge ${activeDemo ? 'demo' : overallBaselineState}`}>{activeDemo ? 'Demo only' : overallBaselineState}</span>
            <strong>{presentationPattern.activity_fusion.confidence === 'none' ? 'Available data only' : `${presentationPattern.activity_fusion.confidence} confidence`}</strong>
            <small>{presentationPattern.supporting_sources.length ? `${presentationPattern.supporting_sources.length} supporting source${presentationPattern.supporting_sources.length === 1 ? '' : 's'}` : 'No movement source yet'}</small>
          </div>
        </section>

        <section className={`support-section ${presentationPattern.status === 'changed' ? 'prominent' : 'quiet'}`} id="check-in" aria-labelledby="check-in-heading">
          <div className="section-intro compact-intro">
            <div><p className="eyebrow">{activeDemo ? 'Demo-only supportive response' : 'A moment for you'}</p><h2 id="check-in-heading">{presentationPattern.status === 'changed' ? 'A few parts of your routine shifted. How are you feeling today?' : 'How are you feeling today?'}</h2></div>
            {mood && <span className="state-badge qualified">Checked in · {moodLabel}</span>}
          </div>
          <div className="mood-buttons">
            {Object.keys(MOOD_SCORES).map((label) => <button key={label} onClick={() => checkInMood(label)}>{label}</button>)}
          </div>
          <div className="inline-input"><input aria-label="Add optional check-in context" value={customMood} maxLength={160} placeholder="Add a little context…" onChange={(event) => setCustomMood(event.target.value)} /><button onClick={() => customMood.trim() && checkInMood('custom', customMood.trim())}>Save locally</button></div>
          <div className="support-actions">
            {!recording
              ? <button type="button" onClick={() => void startVoice()} disabled={companionBusy}>Talk to WithYou <span aria-hidden="true">🎙️</span></button>
              : <button type="button" className="recording-button" onClick={stopVoice}>Stop recording</button>}
            <span>{voiceMessage || 'Voice input starts only when you tap. It is never used as sensor data.'}</span>
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
            <span className={`state-badge ${activeDemo ? 'demo' : presentationPattern.activity_fusion.interpretation === 'mixed' ? 'adapting' : presentationPattern.status === 'changed' ? 'learning' : 'qualified'}`}>
              {activeDemo ? 'Simulated scenario' : presentationPattern.activity_fusion.confidence === 'none' ? 'Limited evidence' : `${presentationPattern.activity_fusion.confidence} confidence`}
            </span>
          </div>
          <p className="evidence-lead">{presentationPattern.activity_fusion.note}</p>
          {activeDemo && <p className="simulation-disclosure"><strong>Demo Simulation:</strong> The evidence below exists only in memory for this presentation and is not saved as user data.</p>}
          <p className="evidence-context">Home Sensor readings add room context only and never substitute for phone or Health movement data.</p>
          <details className="inline-disclosure evidence-details">
            <summary>See source details</summary>
            <dl className="evidence-list">
              <div><dt>Supporting</dt><dd>{presentationPattern.supporting_sources.length ? presentationPattern.supporting_sources.map(readableSourceName).join(', ') : 'None available yet'}</dd></div>
              <div><dt>Conflicting</dt><dd>{presentationConflictingSources.length ? presentationConflictingSources.join(', ') : presentationPattern.activity_fusion.interpretation === 'mixed' ? 'Phone motion, Health steps' : 'None identified'}</dd></div>
              <div><dt>Missing</dt><dd>{presentationPattern.missing_sources.length ? presentationPattern.missing_sources.map(readableSourceName).join(', ') : 'None'}</dd></div>
              <div><dt>Baseline</dt><dd>{activeDemo ? 'Demo reference values only' : overallBaselineState === 'learning' ? 'Still learning your routine' : overallBaselineState === 'adapting' ? 'Learning a repeated routine change gradually' : 'Qualified rolling baselines available'}</dd></div>
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
              <span className={!activeDemo && homeSessionId && homeSessionFreshness.state === 'offline' ? 'stale-reading' : ''}>Temperature <strong>{environmentTemperature ? `${environmentTemperature.value} °F` : '—'}</strong><small>{activeDemo && demoTemperature ? 'Demo-only simulated value' : homeSessionId ? homeSensorValueLabel(homeSessionFreshness, Boolean(environmentTemperature)) : environmentTemperature ? environmentTemperature.is_simulated ? 'Saved simulated value' : 'Saved local value' : 'No reading'}</small></span>
              <span className={!activeDemo && homeSessionId && homeSessionFreshness.state === 'offline' ? 'stale-reading' : ''}>Humidity <strong>{environmentHumidity ? `${environmentHumidity.value}%` : '—'}</strong><small>{activeDemo && demoHumidity ? 'Demo-only simulated value' : homeSessionId ? homeSensorValueLabel(homeSessionFreshness, Boolean(environmentHumidity)) : environmentHumidity ? environmentHumidity.is_simulated ? 'Saved simulated value' : 'Saved local value' : 'No reading'}</small></span>
              <span className={!activeDemo && homeSessionId && homeSessionFreshness.state === 'offline' ? 'stale-reading' : ''}>Light <strong>{environmentLight ? `${environmentLight.value} lux` : '—'}</strong><small>{activeDemo && demoLight ? 'Demo-only simulated value' : homeSessionId ? homeSensorValueLabel(homeSessionFreshness, Boolean(environmentLight)) : environmentLight ? environmentLight.is_simulated ? 'Saved simulated value' : 'Saved local value' : 'No reading'}</small></span>
            </div>
            {activeDemo && <p className="simulation-disclosure"><strong>Demo Simulation:</strong> Room values shown by the active scenario are temporary and do not replace Pico readings.</p>}
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
            <div className="utility-content demo-panel">
              <div><h3>Choose a scenario</h3><p className="microcopy">Selecting does not run anything. Apply it when you are ready to demonstrate.</p></div>
              <div className="demo-scenario-grid" role="radiogroup" aria-label="Demo scenario">
                {DEMO_SCENARIOS.map((scenario) => <button
                  key={scenario.id}
                  type="button"
                  role="radio"
                  aria-checked={demoScenario.selected === scenario.id}
                  className={demoScenario.selected === scenario.id ? 'selected' : ''}
                  onClick={() => chooseDemoScenario(scenario.id)}
                ><strong>{scenario.label}</strong><span>{scenario.description}</span></button>)}
              </div>
              <div className="demo-run-row">
                <button className="accent-button" type="button" disabled={!demoScenario.selected} onClick={runSelectedDemoScenario}>Run Demo Scenario</button>
                {activeDemo && <button type="button" onClick={clearDemoScenario}>Exit Demo</button>}
                <span>{activeDemo ? `Demo Simulation active: ${activeDemo.label}. Nothing was saved.` : 'No simulated scenario is active.'}</span>
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
                <p>Phone sensing uses motion only and runs while WithYou is open and active.</p>
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
          <section>
            {platform.isDesktop ? <>
              <div className="panel-section-heading"><div><p className="eyebrow">Viewing portal</p><h3>Phone activity</h3></div><span className={`status-label ${realActivity ? 'live' : 'muted'}`}>{realActivity ? 'Summary available' : 'Connect on mobile'}</span></div>
              <div className={`source-status-alert ${realActivity ? 'success' : 'muted'}`}><strong>{realActivity ? 'Latest phone activity summary' : 'Use WithYou on your phone'}</strong><span>{realActivity ? `Last mobile motion summary ${formatTime(realActivity.timestamp)}. This computer is only displaying the available result.` : 'Open WithYou on your phone and choose Connect Phone there. This desktop does not request motion permission.'}</span></div>
              <p className="microcopy">Phone motion stays local to the browser where it was collected. Desktop WithYou never treats laptop movement as phone activity.</p>
            </> : <>
              <div className="panel-section-heading"><div><p className="eyebrow">Phone activity</p><h3>Motion summaries</h3></div><span className={`status-label ${motionStatus === 'connected' ? 'live' : motionStatus === 'unavailable' ? 'offline' : 'muted'}`}>{motionStatus === 'connected' ? 'Connected · updating automatically' : motionStatus === 'unavailable' ? 'Unavailable' : 'Permission needed'}</span></div>
              <div className={`source-status-alert ${motionStatus === 'connected' ? 'success' : motionStatus === 'unavailable' ? 'muted' : 'attention'}`}><strong>{motionStatus === 'connected' ? 'Phone is connected' : motionStatus === 'unavailable' ? 'Motion is unavailable here' : 'Your permission is needed'}</strong><span>{motionMessage}</span></div>
              <button className="primary" onClick={handleConnectPhone} disabled={motionStatus === 'connecting' || motionStatus === 'connected' || motionStatus === 'unavailable'}>{motionStatus === 'connecting' ? 'Connecting…' : motionStatus === 'connected' ? 'Phone connected' : 'Connect Phone'}</button>
              <p className="microcopy">WithYou summarizes motion every few seconds while this page is open and active. It does not claim to sense after the browser is closed.</p>
            </>}
          </section>
        </div>}
        {activeSourcePanel === 'health' && <div className="panel-stack">
          <section>
            <div className="panel-section-heading"><div><p className="eyebrow">Android health</p><h3>{healthState === 'connected' ? 'Latest compact summaries' : 'Set up Health Connect'}</h3></div><span className={`status-label ${healthState === 'connected' ? 'live' : healthState === 'sync_needed' ? 'offline' : 'muted'}`}>{healthState === 'connected' ? 'Connected · synced' : healthState === 'sync_needed' ? 'Sync needed' : 'Not connected'}</span></div>
            <div className={`source-status-alert ${healthState === 'connected' ? 'success' : healthState === 'sync_needed' ? 'attention' : 'muted'}`}><strong>{healthState === 'connected' ? `Last synced ${formatTime(healthLastSyncedAt)}` : healthState === 'sync_needed' ? 'Health needs a fresh sync' : 'Connect from a supported Android phone'}</strong><span>{healthState === 'connected' ? 'Only compact current and 30-day baseline summaries are available here.' : 'WithYou Health Helper securely brings in compact steps, sleep, and heart-rate summaries when you choose to sync.'}</span></div>
            {healthPanel.showSummaries && <dl className="health-summary-grid">
              <div><dt>Steps</dt><dd>{currentHealthMetrics.steps ? Math.round(currentHealthMetrics.steps.value).toLocaleString() : 'Not available'}</dd></div>
              <div><dt>Sleep</dt><dd>{currentHealthMetrics.sleep ? `${currentHealthMetrics.sleep.value.toFixed(1)} h` : 'Not available'}</dd></div>
              <div><dt>Heart rate</dt><dd>{currentHealthMetrics.heart_rate ? `${Math.round(currentHealthMetrics.heart_rate.value)} bpm` : 'Not available'}</dd></div>
            </dl>}
            {!platform.isDesktop && platform.isAndroid && healthState !== 'connected' && healthBridgeReturn !== 'not_installed' && <a className="button-link primary" href={healthBridgeLink} onClick={() => {
              setHealthGuideStarted(true)
              setHealthBridgeMessage('Opening WithYou Health Helper…')
            }}>{healthGuideStarted ? 'Open WithYou Health Helper' : 'Connect Health'}</a>}
            {!platform.isDesktop && platform.isAndroid && healthState !== 'connected' && healthBridgeMessage && healthBridgeReturn !== 'not_installed' && <div className="health-bridge-message" role="status"><strong>{healthBridgeMessage}</strong><span>Follow the permission and sync steps in the helper. WithYou checks again as soon as you return.</span></div>}
            {healthPanel.showPrimaryInstall && <div className="health-install-card" role="status">
              <div><p className="eyebrow">One small Android helper</p><h4>{healthBridgeMessage}</h4><p>It connects your phone’s Health Connect data with WithYou so your steps, sleep, and heart-rate summaries can appear here.</p></div>
              <a
                className="button-link primary"
                href={HEALTH_HELPER_APK_URL}
                download="withyou-health-helper.apk"
                onClick={() => setHealthInstallStarted(true)}
              >{healthInstallStarted ? 'Download again' : 'Install WithYou Health Helper'}</a>
              <ol className="health-install-steps">
                <li>{healthInstallStarted ? 'Tap the completed download notification' : 'Start the download and keep this page open'}</li>
                <li>Tap Install when Android asks</li>
                <li>Return to WithYou</li>
              </ol>
              {healthInstallStarted && <div className="health-download-guidance" role="status">
                <strong>Download started</strong>
                <span>Chrome should show a completed-download notification. Tap it to open the installer. If nothing finishes, use Download again or open the GitHub release page below.</span>
              </div>}
              <div className="health-install-fallbacks" aria-label="Health Helper download alternatives">
                <a className="button-link" href={HEALTH_HELPER_RELEASE_URL} target="_blank" rel="noreferrer">Open GitHub release page</a>
                <a href={HEALTH_HELPER_INSTALL_HELP_URL} target="_blank" rel="noreferrer">Installation help</a>
              </div>
              <a className="button-link" href={healthBridgeLink}>Open WithYou Health Helper</a>
              <p className="microcopy">Android will always show its own install confirmation. This hackathon app is not listed in an app store. If the direct download is blocked, the <a href={HEALTH_HELPER_GITHUB_APK_URL}>GitHub asset</a> remains available as a secondary fallback.</p>
            </div>}
            {!platform.isDesktop && platform.isAndroid && healthState !== 'connected' && healthState === 'sync_needed' && healthBridgeReturn !== 'not_installed' && <div className="health-setup-guide"><h4>Continue in WithYou Health Helper</h4><p>Review Health permissions, then tap Sync health data. The helper can open the right Android settings when needed.</p><a className="button-link" href={healthBridgeLink}>Open WithYou Health Helper</a></div>}
            {!platform.isDesktop && !platform.isAndroid && healthState !== 'connected' && <div className="health-setup-guide"><h4>Health Connect requires Android</h4><p>WithYou does not currently connect to Apple Health. You can still use phone motion, check-ins, Home Sensor summaries, and the companion on this device.</p></div>}
            {platform.isDesktop && healthState !== 'connected' && <div className="health-setup-guide"><h4>Connect Health from your Android phone</h4><p>Open WithYou on Android, choose Connect Health, and complete the permission and sync steps there. This desktop view checks automatically for compact synced summaries.</p></div>}
            <button type="button" onClick={() => setHealthRefreshKey((value) => value + 1)}>{healthState === 'connected' ? 'Refresh summaries' : 'Check sync again'}</button>
            {healthPanel.showAndroidManagement && <section className="health-management-card" aria-labelledby="health-management-title">
              <div><p className="eyebrow">Connection controls</p><h4 id="health-management-title">Manage Health connection</h4><p>Open the helper whenever you want to sync now, review permissions, or reach Android’s Health Connect settings.</p></div>
              <div className="health-management-actions">
                <a className="button-link primary" href={healthBridgeLink}>Open WithYou Health Helper</a>
                <a className="button-link" href={healthBridgeLink}>Sync now</a>
                <a className="button-link" href={healthBridgeLink}>Review Health permissions</a>
                <a className="button-link" href={healthBridgeLink}>Health Connect settings</a>
              </div>
              <p className="microcopy">The helper syncs automatically when it opens. Its Review health permissions action opens the supported Android permission or Health Connect settings screen.</p>
              <details className="health-recovery-details">
                <summary>Installation or update help</summary>
                <div className="health-install-fallbacks">
                  <a href={HEALTH_HELPER_APK_URL} download="withyou-health-helper.apk">Download or reinstall the helper</a>
                  <a href={HEALTH_HELPER_RELEASE_URL} target="_blank" rel="noreferrer">Open GitHub release page</a>
                  <a href={HEALTH_HELPER_INSTALL_HELP_URL} target="_blank" rel="noreferrer">Installation help</a>
                </div>
              </details>
            </section>}
            {healthPanel.showDesktopManagementNote && <div className="health-setup-guide health-desktop-management"><h4>Manage Health from your Android phone</h4><p>Open WithYou Health Helper on the phone that provides these summaries to sync now, review permissions, or open Health Connect settings.</p></div>}
          </section>
        </div>}
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
          {clinicalSummary && <><article className="clinical-summary-preview" aria-label="Clinical summary preview"><p className="eyebrow">Clinician-ready preview</p><h2>{clinicalSummary.title}</h2><p className="clinical-disclaimer"><strong>{clinicalSummary.disclaimer}</strong></p><dl className="clinical-summary-meta"><div><dt>Date range</dt><dd>{clinicalSummary.dateRange}</dd></div><div><dt>Generated</dt><dd>{new Date(clinicalSummary.generatedAt).toLocaleString()}</dd></div></dl>{clinicalSummary.sections.map((section) => <section className={`clinical-section ${section.kind ?? 'comparison'}`} key={section.heading}><h3>{section.heading}</h3><ul>{section.lines.map((line, index) => <li key={`${section.heading}-${index}`}>{line}</li>)}</ul></section>)}</article><div className="clinical-summary-actions"><button type="button" onClick={() => void copyClinicalSummary()}>Copy summary</button><button type="button" onClick={downloadClinicalSummary}>Download text</button><button type="button" onClick={() => window.print()}>Print / Save as PDF</button></div></>}
        </div>
      </OverlayPanel>
    </>
  )
}
