import type { BaselineProfile, SensorReading } from './types.ts'

export type HealthMetric = 'steps' | 'sleep' | 'heart_rate'

export interface SelectedHealthSummaries {
  current: Partial<Record<HealthMetric, SensorReading>>
  baseline: Partial<Record<HealthMetric, SensorReading>>
}

const HEALTH_METRICS = new Set<HealthMetric>(['steps', 'sleep', 'heart_rate'])

function isNewer(candidate: SensorReading, existing?: SensorReading) {
  if (!existing) return true
  return new Date(candidate.timestamp).getTime() > new Date(existing.timestamp).getTime()
}

export function selectHealthConnectSummaries(readings: SensorReading[]): SelectedHealthSummaries {
  const selected: SelectedHealthSummaries = { current: {}, baseline: {} }

  readings.forEach((reading) => {
    if (
      reading.source !== 'watch'
      || reading.metadata.provider !== 'health_connect'
      || reading.metadata.raw_history_uploaded !== false
      || !HEALTH_METRICS.has(reading.sensor_type as HealthMetric)
    ) return

    const kind = reading.metadata.summary_kind
    if (kind !== 'current' && kind !== 'baseline') return
    const metric = reading.sensor_type as HealthMetric
    if (isNewer(reading, selected[kind][metric])) selected[kind][metric] = reading
  })

  return selected
}

export function applyHealthConnectBaselines(
  fallback: BaselineProfile,
  summaries: SelectedHealthSummaries,
): BaselineProfile {
  const steps = summaries.baseline.steps?.value
  const sleep = summaries.baseline.sleep?.value
  const heartRate = summaries.baseline.heart_rate?.value

  return {
    ...fallback,
    normal_daily_steps: steps ?? fallback.normal_daily_steps,
    normal_sleep_duration: sleep ?? fallback.normal_sleep_duration,
    normal_heart_rate: heartRate ?? fallback.normal_heart_rate,
    steps_baseline_source: steps == null ? fallback.steps_baseline_source : 'health_connect',
    sleep_baseline_source: sleep == null ? fallback.sleep_baseline_source : 'health_connect',
    heart_rate_baseline_source: heartRate == null ? fallback.heart_rate_baseline_source : 'health_connect',
  }
}

export function currentHealthReadings(summaries: SelectedHealthSummaries): SensorReading[] {
  return Object.values(summaries.current).filter((reading): reading is SensorReading => reading != null)
}
