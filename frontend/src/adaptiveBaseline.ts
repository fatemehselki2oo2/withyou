import type {
  ActivityFusionAnalysis,
  BaselineDataConfidence,
  BaselineDataQualification,
  BaselineProfile,
  BaselineQualificationState,
  SensorReading,
} from './types.ts'
import type { SelectedHealthSummaries } from './healthSummarySelection.ts'

export type BaselineState = BaselineQualificationState
export type DataConfidence = BaselineDataConfidence
export type AdaptiveMetric = 'phone_motion' | 'steps' | 'sleep_duration' | 'sleep_start' | 'wake_time' | 'heart_rate'

export type DataQualification = BaselineDataQualification

export interface AdaptiveMetricState {
  state: BaselineState
  mean: number | null
  standard_deviation: number
  sample_count: number
  recent_qualified_day_count: number
  last_updated: string | null
  recent_observation_ids: string[]
  candidate_mean: number | null
  candidate_count: number
  candidate_last_day: string | null
}

export interface AdaptiveBaselineProfile {
  id: 'adaptive'
  version: 1
  learning_started_at: string
  metrics: Record<AdaptiveMetric, AdaptiveMetricState>
  last_qualifications: Record<string, DataQualification>
  last_updated: string | null
}

export const INITIAL_BASELINE_LEARNING_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

interface LearningInput {
  metric: AdaptiveMetric
  observation_id: string
  day: string
  value: number
  qualification: DataQualification
  seed_count?: number
  seed_standard_deviation?: number
}

const METRIC_CONFIG: Record<AdaptiveMetric, {
  circular?: boolean
  outlier_floor: number
  candidate_tolerance: number
  max_update: number
}> = {
  phone_motion: { outlier_floor: 0.25, candidate_tolerance: 0.12, max_update: 0.04 },
  steps: { outlier_floor: 2500, candidate_tolerance: 1800, max_update: 600 },
  sleep_duration: { outlier_floor: 1.5, candidate_tolerance: 0.75, max_update: 0.25 },
  sleep_start: { circular: true, outlier_floor: 90, candidate_tolerance: 60, max_update: 20 },
  wake_time: { circular: true, outlier_floor: 90, candidate_tolerance: 60, max_update: 20 },
  heart_rate: { outlier_floor: 15, candidate_tolerance: 8, max_update: 2 },
}

function metricState(mean: number | null): AdaptiveMetricState {
  return {
    state: 'learning',
    mean,
    standard_deviation: 0,
    sample_count: 0,
    recent_qualified_day_count: 0,
    last_updated: null,
    recent_observation_ids: [],
    candidate_mean: null,
    candidate_count: 0,
    candidate_last_day: null,
  }
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function normalizeClock(value: number): number {
  return ((value % 1440) + 1440) % 1440
}

function difference(metric: AdaptiveMetric, value: number, mean: number): number {
  if (!METRIC_CONFIG[metric].circular) return value - mean
  return ((value - mean + 720) % 1440 + 1440) % 1440 - 720
}

function formatClock(value: number): string {
  const normalized = Math.round(normalizeClock(value))
  const hours = Math.floor(normalized / 60) % 24
  const minutes = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function createAdaptiveProfile(fallback: BaselineProfile, now = new Date()): AdaptiveBaselineProfile {
  return {
    id: 'adaptive',
    version: 1,
    learning_started_at: now.toISOString(),
    metrics: {
      phone_motion: metricState(fallback.normal_activity_level),
      steps: metricState(fallback.normal_daily_steps),
      sleep_duration: metricState(fallback.normal_sleep_duration),
      sleep_start: metricState(clockMinutes(fallback.normal_sleep_start)),
      wake_time: metricState(clockMinutes(fallback.normal_wake_time)),
      heart_rate: metricState(fallback.normal_heart_rate),
    },
    last_qualifications: {},
    last_updated: null,
  }
}

export function restoreAdaptiveProfile(
  saved: AdaptiveBaselineProfile | null | undefined,
  fallback: BaselineProfile,
): AdaptiveBaselineProfile {
  const fresh = createAdaptiveProfile(fallback)
  if (!saved || saved.version !== 1) return fresh
  const savedStart = saved.learning_started_at
    ?? Object.values(saved.metrics ?? {}).map((metric) => metric?.last_updated).filter(Boolean).sort()[0]
    ?? saved.last_updated
    ?? fresh.learning_started_at
  return {
    ...fresh,
    ...saved,
    learning_started_at: savedStart,
    metrics: Object.fromEntries(
      Object.entries(fresh.metrics).map(([metric, defaultState]) => [
        metric,
        { ...defaultState, ...saved.metrics?.[metric as AdaptiveMetric] },
      ]),
    ) as Record<AdaptiveMetric, AdaptiveMetricState>,
  }
}

export function initialBaselineLearning(
  profile: AdaptiveBaselineProfile,
  now = new Date(),
): { active: boolean; elapsed_days: number; remaining_days: number; has_established_metric: boolean } {
  const started = new Date(profile.learning_started_at).getTime()
  const current = now.getTime()
  const elapsedDays = Number.isFinite(started) && Number.isFinite(current)
    ? Math.max(0, Math.floor((current - started) / DAY_MS))
    : 0
  const hasEstablishedMetric = Object.values(profile.metrics)
    .some((metric) => metric.state === 'qualified' || metric.state === 'adapting')
  const remainingDays = Math.max(0, INITIAL_BASELINE_LEARNING_DAYS - elapsedDays)
  return {
    active: remainingDays > 0 || !hasEstablishedMetric,
    elapsed_days: elapsedDays,
    remaining_days: remainingDays,
    has_established_metric: hasEstablishedMetric,
  }
}

function qualification(
  confidence: DataConfidence,
  qualified: boolean,
  supporting: string[],
  conflicting: string[],
  reason: string,
): DataQualification {
  return {
    confidence,
    qualified_for_baseline: qualified,
    supporting_sources: supporting,
    conflicting_sources: conflicting,
    reason,
  }
}

function datePart(value: string | undefined, fallback = new Date().toISOString()): string {
  return (value ?? fallback).slice(0, 10)
}

function numericMetadata(reading: SensorReading | undefined, key: string): number | undefined {
  const value = reading?.metadata[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function buildLearningInputs(
  readings: SensorReading[],
  health: SelectedHealthSummaries,
  fusion: ActivityFusionAnalysis,
): { inputs: LearningInput[]; qualifications: Record<string, DataQualification> } {
  const inputs: LearningInput[] = []
  const qualifications: Record<string, DataQualification> = {}
  const phoneReadings = readings.filter((reading) => (
    reading.source === 'phone'
    && reading.sensor_type === 'activity'
    && !reading.is_simulated
    && reading.metadata.summary_kind !== 'baseline'
  ))
  const simulatedPhoneReadings = readings.filter((reading) => (
    reading.source === 'phone' && reading.sensor_type === 'activity' && reading.is_simulated
  ))

  if (phoneReadings.length) {
    const value = phoneReadings.reduce((sum, reading) => sum + reading.value, 0) / phoneReadings.length
    const day = datePart(phoneReadings.at(-1)?.timestamp)
    const mixed = fusion.interpretation === 'mixed'
    const confidence: DataConfidence = fusion.confidence === 'high' ? 'high' : mixed ? 'low' : 'medium'
    const result = qualification(
      confidence,
      !mixed,
      ['phone_motion'],
      mixed ? ['watch_steps'] : [],
      mixed
        ? 'Phone motion conflicts with watch steps, so it will not update the phone baseline.'
        : 'Daily phone-motion summary is eligible for its source-specific baseline.',
    )
    qualifications.phone_motion = result
    inputs.push({ metric: 'phone_motion', observation_id: `phone_motion:${day}`, day, value, qualification: result })
  } else if (simulatedPhoneReadings.length) {
    qualifications.phone_motion = qualification(
      'low', false, ['phone_motion'], [], 'Simulated phone motion is excluded from personal baseline learning.',
    )
  }

  const stepsBaseline = health.baseline.steps
  if (stepsBaseline) {
    const days = numericMetadata(stepsBaseline, 'days_with_data') ?? 0
    const day = datePart(String(stepsBaseline.metadata.window_end ?? stepsBaseline.timestamp))
    const result = qualification(
      days >= 7 ? 'high' : 'medium',
      days >= 7,
      ['watch_steps'],
      [],
      days >= 7
        ? `Compact Health Connect baseline represents ${days} completed days.`
        : 'More completed watch-step days are needed before adapting the baseline.',
    )
    qualifications.steps = result
    inputs.push({
      metric: 'steps',
      observation_id: `steps_baseline:${day}`,
      day,
      value: stepsBaseline.value,
      qualification: result,
      seed_count: Math.min(30, Math.floor(days)),
      seed_standard_deviation: numericMetadata(stepsBaseline, 'standard_deviation'),
    })
  }
  if (health.current.steps) {
    qualifications.steps_current = qualification(
      'low',
      false,
      ['watch_steps'],
      [],
      'Today’s step total is partial and is excluded from baseline learning.',
    )
  }

  const sleepBaseline = health.baseline.sleep
  if (sleepBaseline) {
    const sessions = numericMetadata(sleepBaseline, 'completed_session_count') ?? 0
    const day = datePart(String(sleepBaseline.metadata.window_end ?? sleepBaseline.timestamp))
    const result = qualification(
      sessions >= 7 ? 'high' : 'medium',
      sessions >= 7,
      ['health_connect_sleep'],
      [],
      sessions >= 7
        ? `Compact sleep baseline represents ${sessions} completed sessions.`
        : 'More completed sleep sessions are needed before adapting duration.',
    )
    qualifications.sleep_duration = result
    inputs.push({
      metric: 'sleep_duration',
      observation_id: `sleep_baseline:${day}`,
      day,
      value: sleepBaseline.value,
      qualification: result,
      seed_count: Math.min(30, Math.floor(sessions)),
      seed_standard_deviation: numericMetadata(sleepBaseline, 'standard_deviation'),
    })
  }

  const currentSleep = health.current.sleep
    ?? readings.filter((reading) => reading.sensor_type === 'sleep' && reading.metadata.summary_kind !== 'baseline').at(-1)
  if (currentSleep) {
    const isDemo = currentSleep.is_simulated
    const day = datePart(String(currentSleep.metadata.wake_time ?? currentSleep.timestamp))
    const result = qualification(
      isDemo ? 'low' : 'medium',
      !isDemo,
      [currentSleep.source === 'watch' ? 'health_connect_sleep' : 'manual_sleep'],
      [],
      isDemo ? 'Simulated sleep is not used for personal learning.' : 'Completed sleep summary is eligible for gradual learning.',
    )
    qualifications.sleep_current = result
    inputs.push({ metric: 'sleep_duration', observation_id: `sleep:${day}`, day, value: currentSleep.value, qualification: result })

    const start = currentSleep.metadata.sleep_start
    const wake = currentSleep.metadata.wake_time
    if (typeof start === 'string' && typeof wake === 'string') {
      const startDate = new Date(start)
      const wakeDate = new Date(wake)
      if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(wakeDate.getTime())) {
        inputs.push({
          metric: 'sleep_start', observation_id: `sleep_start:${day}`, day,
          value: startDate.getHours() * 60 + startDate.getMinutes(), qualification: result,
        })
        inputs.push({
          metric: 'wake_time', observation_id: `wake_time:${day}`, day,
          value: wakeDate.getHours() * 60 + wakeDate.getMinutes(), qualification: result,
        })
      }
    }
  }

  const heartBaseline = health.baseline.heart_rate
  if (heartBaseline) {
    const day = datePart(String(heartBaseline.metadata.window_end ?? heartBaseline.timestamp))
    const requestedDays = numericMetadata(heartBaseline, 'requested_days') ?? 30
    const result = qualification(
      'high',
      requestedDays >= 7,
      ['health_connect_heart_rate'],
      [],
      'Only the compact multi-day heart-rate summary is used; raw samples remain in Health Connect.',
    )
    qualifications.heart_rate = result
    inputs.push({
      metric: 'heart_rate',
      observation_id: `heart_rate_baseline:${day}`,
      day,
      value: heartBaseline.value,
      qualification: result,
      seed_count: Math.min(30, Math.floor(requestedDays)),
      seed_standard_deviation: numericMetadata(heartBaseline, 'standard_deviation'),
    })
  }

  return { inputs, qualifications }
}

function updateMetric(state: AdaptiveMetricState, input: LearningInput): AdaptiveMetricState {
  if (state.recent_observation_ids.includes(input.observation_id) || !input.qualification.qualified_for_baseline) {
    return state
  }

  const config = METRIC_CONFIG[input.metric]
  const recentIds = [...state.recent_observation_ids, input.observation_id].slice(-30)
  const seedCount = Math.max(0, input.seed_count ?? 1)
  if (state.sample_count === 0 && input.seed_count && input.seed_count >= 7) {
    return {
      ...state,
      state: 'qualified',
      mean: config.circular ? normalizeClock(input.value) : input.value,
      standard_deviation: input.seed_standard_deviation ?? state.standard_deviation,
      sample_count: seedCount,
      recent_qualified_day_count: Math.min(30, seedCount),
      last_updated: input.day,
      recent_observation_ids: recentIds,
    }
  }

  const currentMean = state.mean ?? input.value
  const delta = difference(input.metric, input.value, currentMean)
  const threshold = Math.max(config.outlier_floor, state.standard_deviation * 3)
  const isOutlier = state.sample_count >= 3 && Math.abs(delta) > threshold

  if (isOutlier) {
    const candidateDelta = state.candidate_mean == null
      ? 0
      : Math.abs(difference(input.metric, input.value, state.candidate_mean))
    const continuesCandidate = state.candidate_mean == null || candidateDelta <= config.candidate_tolerance
    const candidateCount = continuesCandidate && state.candidate_last_day !== input.day
      ? state.candidate_count + 1
      : continuesCandidate ? state.candidate_count : 1
    const candidateMean = continuesCandidate && state.candidate_mean != null
      ? config.circular
        ? normalizeClock(state.candidate_mean + difference(input.metric, input.value, state.candidate_mean) / candidateCount)
        : state.candidate_mean + (input.value - state.candidate_mean) / candidateCount
      : input.value

    if (candidateCount < 5) {
      return {
        ...state,
        candidate_mean: candidateMean,
        candidate_count: candidateCount,
        candidate_last_day: input.day,
        recent_observation_ids: recentIds,
      }
    }

    const boundedDelta = Math.max(-config.max_update, Math.min(config.max_update, delta * 0.08))
    const nextMean = config.circular ? normalizeClock(currentMean + boundedDelta) : currentMean + boundedDelta
    return {
      ...state,
      state: candidateCount >= 14 ? 'qualified' : 'adapting',
      mean: nextMean,
      standard_deviation: Math.sqrt(state.standard_deviation ** 2 * 0.9 + boundedDelta ** 2 * 0.1),
      sample_count: state.sample_count + 1,
      recent_qualified_day_count: Math.min(30, state.recent_qualified_day_count + 1),
      last_updated: input.day,
      recent_observation_ids: recentIds,
      candidate_mean: candidateCount >= 14 ? null : candidateMean,
      candidate_count: candidateCount >= 14 ? 0 : candidateCount,
      candidate_last_day: candidateCount >= 14 ? null : input.day,
    }
  }

  const alpha = 1 / Math.min(30, Math.max(7, state.sample_count + 1))
  const boundedDelta = Math.max(-config.max_update, Math.min(config.max_update, delta * alpha))
  const nextMean = config.circular ? normalizeClock(currentMean + boundedDelta) : currentMean + boundedDelta
  const nextCount = state.sample_count + Math.max(1, seedCount)
  return {
    ...state,
    state: nextCount >= 7 ? 'qualified' : 'learning',
    mean: nextMean,
    standard_deviation: Math.sqrt(state.standard_deviation ** 2 * (1 - alpha) + delta ** 2 * alpha),
    sample_count: nextCount,
    recent_qualified_day_count: Math.min(30, state.recent_qualified_day_count + 1),
    last_updated: input.day,
    recent_observation_ids: recentIds,
    candidate_mean: null,
    candidate_count: 0,
    candidate_last_day: null,
  }
}

export function updateAdaptiveProfile(
  profile: AdaptiveBaselineProfile,
  learning: ReturnType<typeof buildLearningInputs>,
): AdaptiveBaselineProfile {
  const metrics = { ...profile.metrics }
  const qualifications = { ...learning.qualifications }
  learning.inputs.forEach((input) => {
    const previous = metrics[input.metric]
    const next = updateMetric(previous, input)
    metrics[input.metric] = next
    if (
      input.qualification.qualified_for_baseline
      && next.candidate_count > 0
      && next.mean === previous.mean
      && next.candidate_count < 5
    ) {
      qualifications[input.metric] = {
        ...input.qualification,
        confidence: 'low',
        qualified_for_baseline: false,
        reason: `Statistical outlier observed on ${next.candidate_count} distinct day${next.candidate_count === 1 ? '' : 's'}; waiting for a repeated pattern.`,
      }
    } else if (next.state === 'adapting' && next.mean !== previous.mean) {
      qualifications[input.metric] = {
        ...input.qualification,
        confidence: input.qualification.confidence === 'high' ? 'high' : 'medium',
        qualified_for_baseline: true,
        reason: 'A consistent change has repeated across at least five days, so the baseline is adapting gradually.',
      }
    }
  })
  const changed = learning.inputs.some((input) => metrics[input.metric] !== profile.metrics[input.metric])
  return {
    ...profile,
    metrics,
    last_qualifications: qualifications,
    last_updated: changed ? new Date().toISOString() : profile.last_updated,
  }
}

export function adaptiveBaselineState(profile: AdaptiveBaselineProfile, now = new Date()): BaselineState {
  if (initialBaselineLearning(profile, now).active) return 'learning'
  const states = Object.values(profile.metrics).map((metric) => metric.state)
  if (states.includes('adapting')) return 'adapting'
  if (states.includes('qualified')) return 'qualified'
  return 'learning'
}

export function applyAdaptiveBaseline(
  fallback: BaselineProfile,
  profile: AdaptiveBaselineProfile,
): BaselineProfile {
  const usable = (metric: AdaptiveMetric) => {
    const state = profile.metrics[metric]
    return state.mean != null && state.state !== 'learning' ? state.mean : null
  }
  const activity = usable('phone_motion')
  const steps = usable('steps')
  const sleepDuration = usable('sleep_duration')
  const sleepStart = usable('sleep_start')
  const wake = usable('wake_time')
  const heartRate = usable('heart_rate')

  return {
    ...fallback,
    normal_activity_level: activity ?? fallback.normal_activity_level,
    normal_daily_steps: steps ?? fallback.normal_daily_steps,
    normal_sleep_duration: sleepDuration ?? fallback.normal_sleep_duration,
    normal_sleep_start: sleepStart == null ? fallback.normal_sleep_start : formatClock(sleepStart),
    normal_wake_time: wake == null ? fallback.normal_wake_time : formatClock(wake),
    normal_heart_rate: heartRate ?? fallback.normal_heart_rate,
    steps_baseline_source: steps == null ? fallback.steps_baseline_source : 'adaptive',
    sleep_baseline_source: sleepDuration == null ? fallback.sleep_baseline_source : 'adaptive',
    heart_rate_baseline_source: heartRate == null ? fallback.heart_rate_baseline_source : 'adaptive',
  }
}
