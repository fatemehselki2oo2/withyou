import type {
  ActivityFusionAnalysis,
  BaselineProfile,
  EvidenceSource,
  PatternAnalysis,
  SensorReading,
  SensorType,
  WellnessContext,
} from './types'
import { adaptiveBaselineState, type AdaptiveBaselineProfile } from './adaptiveBaseline.ts'

type ActivityDirection = 'normal' | 'low' | 'high'

const EXPECTED_SOURCES: EvidenceSource[] = ['phone_motion', 'watch_steps', 'home_sensor']

function latest(readings: SensorReading[], type: SensorType) {
  return readings
    // A baseline is reference data, never a current observation—even when its
    // calculation timestamp is newer than the current summary timestamp.
    .filter((reading) => reading.sensor_type === type && reading.metadata.summary_kind !== 'baseline')
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .at(-1)
}

function minutesFromClock(value: string) {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function wakeMinutes(reading: SensorReading) {
  const wake = reading.metadata.wake_time
  if (typeof wake !== 'string') return null
  const date = new Date(wake)
  return Number.isNaN(date.getTime()) ? null : date.getHours() * 60 + date.getMinutes()
}

function phoneActivityDirection(reading: SensorReading, baseline: BaselineProfile): ActivityDirection {
  if (reading.value < baseline.normal_activity_level * 0.65) return 'low'
  if (reading.value > baseline.normal_activity_level * 1.35) return 'high'
  return 'normal'
}

function watchStepsDirection(reading: SensorReading, baseline: BaselineProfile): ActivityDirection | null {
  if (!baseline.normal_daily_steps) return null
  const localHour = new Date(reading.timestamp).getHours()
  if (localHour >= 18 && reading.value < baseline.normal_daily_steps * 0.6) return 'low'
  if (reading.value > baseline.normal_daily_steps * 1.5) return 'high'
  return 'normal'
}

function availableSources(readings: SensorReading[]): EvidenceSource[] {
  const sources: EvidenceSource[] = []
  if (latest(readings, 'activity')?.source === 'phone') sources.push('phone_motion')
  if (latest(readings, 'steps')?.source === 'watch') sources.push('watch_steps')
  if (readings.some((reading) => (
    reading.source === 'arduino'
    && reading.metadata.summary_kind !== 'baseline'
    && ['temperature', 'humidity', 'light', 'motion', 'proximity'].includes(reading.sensor_type)
  ))) sources.push('home_sensor')
  return sources
}

function fuseActivity(readings: SensorReading[], baseline: BaselineProfile): ActivityFusionAnalysis {
  const phone = latest(readings, 'activity')
  const steps = latest(readings, 'steps')
  const activitySources: EvidenceSource[] = []
  const evidence: Array<{ source: EvidenceSource; direction: ActivityDirection }> = []

  if (phone?.source === 'phone') {
    activitySources.push('phone_motion')
    evidence.push({ source: 'phone_motion', direction: phoneActivityDirection(phone, baseline) })
  }
  if (steps?.source === 'watch') {
    activitySources.push('watch_steps')
    const direction = watchStepsDirection(steps, baseline)
    if (direction) evidence.push({ source: 'watch_steps', direction })
  }

  const missing = (['phone_motion', 'watch_steps'] as EvidenceSource[])
    .filter((source) => !activitySources.includes(source))

  if (evidence.length === 0) {
    return {
      interpretation: 'unavailable',
      confidence: 'none',
      supporting_sources: activitySources,
      missing_sources: missing,
      note: activitySources.length
        ? 'Activity data is available, but a matching personal baseline is not available yet.'
        : 'No movement source is currently available; no activity conclusion was made.',
    }
  }

  if (evidence.length === 1) {
    const direction = evidence[0].direction
    return {
      interpretation: direction === 'normal' ? 'normal' : 'changed',
      confidence: 'normal',
      supporting_sources: activitySources,
      missing_sources: missing,
      note: direction === 'normal'
        ? `Activity looks within normal using ${evidence[0].source === 'phone_motion' ? 'phone motion' : 'watch steps'}.`
        : `Activity looks ${direction === 'low' ? 'lower' : 'higher'} than normal using ${evidence[0].source === 'phone_motion' ? 'phone motion' : 'watch steps'}.`,
    }
  }

  const directions = new Set(evidence.map((item) => item.direction))
  if (directions.size > 1) {
    return {
      interpretation: 'mixed',
      confidence: 'low',
      supporting_sources: activitySources,
      missing_sources: missing,
      note: 'Phone motion and watch steps do not point in the same direction, so no strong activity alert was generated.',
    }
  }

  const direction = evidence[0].direction
  return {
    interpretation: direction === 'normal' ? 'normal' : 'changed',
    confidence: 'high',
    supporting_sources: activitySources,
    missing_sources: missing,
    note: direction === 'normal'
      ? 'Phone motion and watch steps agree that activity looks within normal.'
      : `Phone motion and watch steps agree that activity looks ${direction === 'low' ? 'lower' : 'higher'} than normal.`,
  }
}

function activityReason(fusion: ActivityFusionAnalysis): string | null {
  if (fusion.interpretation !== 'changed') return null
  const hasPhone = fusion.supporting_sources.includes('phone_motion')
  const hasWatch = fusion.supporting_sources.includes('watch_steps')
  if (hasPhone && hasWatch) return 'Available movement sources agree that activity differs meaningfully from your normal'
  if (hasPhone) return 'Phone motion differs meaningfully from your normal'
  if (hasWatch) return 'Watch steps differ meaningfully from your 30-day baseline'
  return null
}

export function analyzePatterns(readings: SensorReading[], baseline: BaselineProfile): PatternAnalysis {
  const reasons: string[] = []
  let primaryChanges = 0
  const activityFusion = fuseActivity(readings, baseline)
  const fusedReason = activityReason(activityFusion)
  if (fusedReason) {
    reasons.push(fusedReason)
    primaryChanges += 1
  }

  const sleep = latest(readings, 'sleep')
  if (sleep) {
    const shorter = sleep.value < baseline.normal_sleep_duration - 2
    const wake = wakeMinutes(sleep)
    const later = wake != null && wake - minutesFromClock(baseline.normal_wake_time) > 120
    if (shorter) reasons.push('Sleep was more than two hours shorter than your normal')
    if (later) reasons.push('Wake time was more than two hours later than your normal')
    if (shorter || later) primaryChanges += 1
  }

  const heartRate = latest(readings, 'heart_rate')
  if (heartRate && baseline.normal_heart_rate) {
    const absoluteDifference = Math.abs(heartRate.value - baseline.normal_heart_rate)
    const proportionalDifference = absoluteDifference / baseline.normal_heart_rate
    if (absoluteDifference >= 10 && proportionalDifference >= 0.15) {
      reasons.push('Your recent heart-rate average differs from your 30-day baseline')
      primaryChanges += 1
    }
  }

  const mood = latest(readings, 'mood')
  const moodLabel = typeof mood?.metadata.label === 'string' ? mood.metadata.label : null
  const moodNeedsSupport = moodLabel != null && ['stressed', 'overwhelmed', 'sad'].includes(moodLabel)
  if (moodNeedsSupport) {
    reasons.push(`You checked in as ${moodLabel}`)
    primaryChanges += 1
  }

  const sound = latest(readings, 'sound_level')
  if (sound && (sound.value > 0.72 || sound.metadata.classification === 'loud')) {
    reasons.push('Your environment has been louder than usual')
  }

  // Home sensors add context only. They never fill in for phone/watch movement.
  const temperature = latest(readings, 'temperature')
  if (temperature && temperature.value > 80) reasons.push('The room reading is warmer than the demo normal')

  const humidity = latest(readings, 'humidity')
  if (humidity && humidity.value > 70) reasons.push('The room humidity reading is higher than the demo normal')

  const supportingSources = availableSources(readings)
  const missingSources = EXPECTED_SOURCES.filter((source) => !supportingSources.includes(source))
  const status = reasons.length ? 'changed' : 'normal'
  return {
    status,
    severity: primaryChanges >= 2 ? 'moderate' : 'low',
    reasons,
    check_in_recommended: primaryChanges >= 2,
    activity_fusion: activityFusion,
    supporting_sources: supportingSources,
    missing_sources: missingSources,
  }
}

export function buildWellnessContext(
  readings: SensorReading[],
  baseline: BaselineProfile,
  pattern: PatternAnalysis,
  adaptiveProfile?: AdaptiveBaselineProfile,
): WellnessContext {
  const activity = latest(readings, 'activity')
  const sleep = latest(readings, 'sleep')
  const steps = latest(readings, 'steps')
  const heartRate = latest(readings, 'heart_rate')
  const sound = latest(readings, 'sound_level')
  const temperature = latest(readings, 'temperature')
  const humidity = latest(readings, 'humidity')
  const light = latest(readings, 'light')
  const mood = latest(readings, 'mood')
  const activityDifference = activity
    ? ((activity.value - baseline.normal_activity_level) / baseline.normal_activity_level) * 100
    : 0
  const stepsDifference = steps && baseline.normal_daily_steps
    ? ((steps.value - baseline.normal_daily_steps) / baseline.normal_daily_steps) * 100
    : 0
  const heartRateDifference = heartRate && baseline.normal_heart_rate
    ? ((heartRate.value - baseline.normal_heart_rate) / baseline.normal_heart_rate) * 100
    : 0
  const stepsDirection = steps ? watchStepsDirection(steps, baseline) : null
  const heartRateChanged = Boolean(heartRate && baseline.normal_heart_rate
    && Math.abs(heartRate.value - baseline.normal_heart_rate) >= 10
    && Math.abs(heartRateDifference) >= 15)
  const soundClass = sound?.metadata.classification

  return {
    activity: activity ? {
      current: activity.value,
      baseline: baseline.normal_activity_level,
      difference_percent: Number(activityDifference.toFixed(1)),
      status: phoneActivityDirection(activity, baseline) === 'normal' ? 'normal' : 'changed',
    } : null,
    sleep: sleep ? {
      hours: sleep.value,
      baseline_hours: baseline.normal_sleep_duration,
      status: sleep.value < baseline.normal_sleep_duration - 2 ? 'changed' : 'normal',
    } : null,
    steps: steps && baseline.normal_daily_steps ? {
      current: steps.value,
      baseline: baseline.normal_daily_steps,
      difference_percent: Number(stepsDifference.toFixed(1)),
      status: stepsDirection === 'low' || stepsDirection === 'high' ? 'changed' : 'normal',
    } : null,
    heart_rate: heartRate && baseline.normal_heart_rate ? {
      current: heartRate.value,
      baseline: baseline.normal_heart_rate,
      difference_percent: Number(heartRateDifference.toFixed(1)),
      status: heartRateChanged ? 'changed' : 'normal',
    } : null,
    environment: {
      temperature: temperature?.value ?? null,
      temperature_source: temperature ? (temperature.is_simulated ? 'simulated' : temperature.source === 'arduino' ? 'arduino' : 'unknown') : null,
      humidity: humidity?.value ?? null,
      light: light?.value ?? null,
      sound_level: soundClass === 'quiet' || soundClass === 'normal' || soundClass === 'loud' ? soundClass : 'unknown',
    },
    mood: typeof mood?.metadata.label === 'string' ? mood.metadata.label : null,
    activity_fusion: pattern.activity_fusion,
    supporting_sources: pattern.supporting_sources,
    missing_sources: pattern.missing_sources,
    baseline_state: adaptiveProfile ? adaptiveBaselineState(adaptiveProfile) : 'learning',
    baseline_states: adaptiveProfile
      ? Object.fromEntries(Object.entries(adaptiveProfile.metrics).map(([metric, state]) => [metric, state.state]))
      : {},
    data_confidence: adaptiveProfile?.last_qualifications ?? {},
    overall_pattern_status: pattern.status,
    severity: pattern.severity,
    reasons: pattern.reasons,
    check_in_recommended: pattern.check_in_recommended,
  }
}

export function latestReading(readings: SensorReading[], type: SensorType) {
  return latest(readings, type)
}
