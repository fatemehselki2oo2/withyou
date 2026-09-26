import type { BaselineProfile, PatternAnalysis, SensorReading, SensorType, WellnessContext } from './types'

function latest(readings: SensorReading[], type: SensorType) {
  return readings
    .filter((reading) => reading.sensor_type === type)
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

export function analyzePatterns(readings: SensorReading[], baseline: BaselineProfile): PatternAnalysis {
  const reasons: string[] = []
  let primaryChanges = 0

  const activity = latest(readings, 'activity')
  if (activity && activity.value < baseline.normal_activity_level * 0.65) {
    reasons.push('Activity is lower than your normal')
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

  const temperature = latest(readings, 'temperature')
  if (temperature && temperature.value > 80) reasons.push('The room reading is warmer than the demo normal')

  const humidity = latest(readings, 'humidity')
  if (humidity && humidity.value > 70) reasons.push('The room humidity reading is higher than the demo normal')

  const status = reasons.length ? 'changed' : 'normal'
  return {
    status,
    severity: primaryChanges >= 2 ? 'moderate' : 'low',
    reasons,
    check_in_recommended: primaryChanges >= 2,
  }
}

export function buildWellnessContext(
  readings: SensorReading[],
  baseline: BaselineProfile,
  pattern: PatternAnalysis,
): WellnessContext {
  const activity = latest(readings, 'activity')
  const sleep = latest(readings, 'sleep')
  const sound = latest(readings, 'sound_level')
  const temperature = latest(readings, 'temperature')
  const humidity = latest(readings, 'humidity')
  const light = latest(readings, 'light')
  const mood = latest(readings, 'mood')
  const activityDifference = activity
    ? ((activity.value - baseline.normal_activity_level) / baseline.normal_activity_level) * 100
    : 0
  const soundClass = sound?.metadata.classification

  return {
    activity: activity ? {
      current: activity.value,
      baseline: baseline.normal_activity_level,
      difference_percent: Number(activityDifference.toFixed(1)),
      status: activity.value < baseline.normal_activity_level * 0.65 ? 'changed' : 'normal',
    } : null,
    sleep: sleep ? {
      hours: sleep.value,
      baseline_hours: baseline.normal_sleep_duration,
      status: sleep.value < baseline.normal_sleep_duration - 2 ? 'changed' : 'normal',
    } : null,
    environment: {
      temperature: temperature?.value ?? null,
      temperature_source: temperature ? (temperature.is_simulated ? 'simulated' : temperature.source === 'arduino' ? 'arduino' : 'unknown') : null,
      humidity: humidity?.value ?? null,
      light: light?.value ?? null,
      sound_level: soundClass === 'quiet' || soundClass === 'normal' || soundClass === 'loud' ? soundClass : 'unknown',
    },
    mood: typeof mood?.metadata.label === 'string' ? mood.metadata.label : null,
    overall_pattern_status: pattern.status,
    severity: pattern.severity,
    reasons: pattern.reasons,
    check_in_recommended: pattern.check_in_recommended,
  }
}

export function latestReading(readings: SensorReading[], type: SensorType) {
  return latest(readings, type)
}

