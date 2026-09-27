import type { AdaptiveBaselineProfile, AdaptiveMetric } from './adaptiveBaseline'
import type {
  BaselineProfile,
  BaselineQualificationState,
  EvidenceConfidence,
  PatternAnalysis,
  WellnessContext,
} from './types'

export const CLINICAL_SUMMARY_DISCLAIMER = 'For discussion with a healthcare professional — not a diagnosis.'

export interface ClinicalSummaryOptions {
  startDate: string
  endDate: string
  includeSleep: boolean
  includeActivity: boolean
  includeHeartRate: boolean
  includeUserContext: boolean
}

export interface ClinicalSummaryTimestamps {
  sleep?: string
  phoneActivity?: string
  steps?: string
  heartRate?: string
}

export interface ClinicalSummaryInput {
  options: ClinicalSummaryOptions
  baseline: BaselineProfile
  adaptiveProfile: AdaptiveBaselineProfile
  pattern: PatternAnalysis
  wellnessContext: WellnessContext
  timestamps: ClinicalSummaryTimestamps
  userContext?: string
  generatedAt?: string
}

export interface ClinicalSummarySection {
  heading: string
  lines: string[]
}

export interface ClinicalSummary {
  title: string
  disclaimer: string
  generatedAt: string
  dateRange: string
  sections: ClinicalSummarySection[]
  supportingSources: string[]
  conflictingSources: string[]
  missingSources: string[]
  text: string
}

const METRIC_LABELS: Record<AdaptiveMetric, string> = {
  phone_motion: 'phone-motion activity',
  steps: 'watch steps',
  sleep_duration: 'sleep duration',
  sleep_start: 'sleep start time',
  wake_time: 'wake time',
  heart_rate: 'heart-rate average',
}

function dateLabel(value: string): string {
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

function timestampInRange(timestamp: string | undefined, startDate: string, endDate: string): boolean {
  if (!timestamp) return false
  const time = new Date(timestamp).getTime()
  const start = new Date(`${startDate}T00:00:00`).getTime()
  const end = new Date(`${endDate}T23:59:59.999`).getTime()
  return Number.isFinite(time) && Number.isFinite(start) && Number.isFinite(end) && time >= start && time <= end
}

function isUsableState(state: BaselineQualificationState): boolean {
  return state === 'qualified' || state === 'adapting'
}

function signedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${Math.round(value)}%`
}

function currentComparison(status: 'normal' | 'changed', difference?: number): string {
  const differenceText = difference == null ? '' : ` (${signedPercent(difference)})`
  return status === 'changed'
    ? `different from personal baseline${differenceText}`
    : `within the current personal-baseline range${differenceText}`
}

function readableSource(source: string): string {
  return source.replaceAll('_', ' ')
}

function overallConfidence(
  metricStates: BaselineQualificationState[],
  fusionConfidence?: EvidenceConfidence,
): string {
  if (!metricStates.length) return 'Limited — no selected qualified personal baseline is available yet.'
  if (fusionConfidence === 'low') return 'Limited — available activity sources conflict.'
  if (metricStates.some((state) => state === 'adapting')) {
    return 'Moderate — at least one personal baseline is adapting to a repeated routine change.'
  }
  if (metricStates.every((state) => state === 'qualified') && fusionConfidence === 'high') {
    return 'High for the available summaries — qualified baselines and agreeing activity sources were available.'
  }
  return 'Moderate — qualified personal baselines were available for the selected summaries.'
}

function reportText(report: Omit<ClinicalSummary, 'text'>): string {
  const lines = [
    report.title,
    report.disclaimer,
    `Date range: ${report.dateRange}`,
    `Generated: ${new Date(report.generatedAt).toLocaleString()}`,
  ]
  for (const section of report.sections) {
    lines.push('', section.heading)
    lines.push(...section.lines.map((line) => `- ${line}`))
  }
  return lines.join('\n')
}

/**
 * Creates a presentation from WithYou's existing interpreted results.
 * The input intentionally has no raw record arrays, samples, stages, or daily history.
 */
export function generateClinicalSummary(input: ClinicalSummaryInput): ClinicalSummary {
  const { options, adaptiveProfile, wellnessContext, pattern, timestamps } = input
  const sections: ClinicalSummarySection[] = []
  const includedMetrics = new Set<AdaptiveMetric>()
  const selectedStates: BaselineQualificationState[] = []
  const addMetricState = (metric: AdaptiveMetric) => {
    const state = adaptiveProfile.metrics[metric].state
    if (isUsableState(state)) {
      includedMetrics.add(metric)
      selectedStates.push(state)
    }
    return state
  }

  if (options.includeSleep) {
    const sleepState = addMetricState('sleep_duration')
    const lines: string[] = []
    if (isUsableState(sleepState)) {
      lines.push(`Personal baseline sleep duration: ${input.baseline.normal_sleep_duration.toFixed(1)} hours (${sleepState}).`)
    } else {
      lines.push('Personal sleep baseline is still learning; no fallback/demo value is presented as personal data.')
    }
    if (wellnessContext.sleep && timestampInRange(timestamps.sleep, options.startDate, options.endDate)) {
      lines.push(isUsableState(sleepState)
        ? `Most recent completed sleep summary: ${wellnessContext.sleep.hours.toFixed(1)} hours — ${currentComparison(wellnessContext.sleep.status)}.`
        : `Most recent completed sleep summary: ${wellnessContext.sleep.hours.toFixed(1)} hours. A comparison is not included while the personal baseline is learning.`)
    } else {
      lines.push('No recent completed sleep summary was available in the selected date range.')
    }
    sections.push({ heading: 'Sleep', lines })
  }

  if (options.includeActivity) {
    const motionState = addMetricState('phone_motion')
    const stepsState = addMetricState('steps')
    const lines: string[] = []
    if (isUsableState(motionState)) {
      lines.push(`Personal phone-motion activity baseline: ${Math.round(input.baseline.normal_activity_level * 100)}% relative activity (${motionState}).`)
    }
    if (isUsableState(stepsState) && input.baseline.normal_daily_steps != null) {
      lines.push(`Personal watch-steps baseline: ${Math.round(input.baseline.normal_daily_steps).toLocaleString()} steps/day (${stepsState}).`)
    }
    if (!isUsableState(motionState) && !isUsableState(stepsState)) {
      lines.push('Personal activity baselines are still learning; no fallback/demo value is presented as personal data.')
    }
    const hasRecentPhone = wellnessContext.activity && timestampInRange(timestamps.phoneActivity, options.startDate, options.endDate)
    const hasRecentSteps = wellnessContext.steps && timestampInRange(timestamps.steps, options.startDate, options.endDate)
    if (hasRecentPhone || hasRecentSteps) {
      const fusion = pattern.activity_fusion
      const fusionSourcesQualified = fusion.supporting_sources.every((source) => (
        source === 'phone_motion' ? isUsableState(motionState)
          : source === 'watch_steps' ? isUsableState(stepsState)
            : true
      ))
      if (fusionSourcesQualified && fusion.interpretation === 'mixed') {
        lines.push('Recent activity evidence was mixed: phone motion and watch steps did not agree, so no strong activity conclusion was made.')
      } else if (fusionSourcesQualified && fusion.interpretation === 'changed') {
        lines.push(`Recent fused activity was different from personal baseline (${fusion.confidence} confidence).`)
      } else if (fusionSourcesQualified && fusion.interpretation === 'normal') {
        lines.push(`Recent fused activity was within the personal-baseline range (${fusion.confidence} confidence).`)
      } else if (!fusionSourcesQualified) {
        lines.push('Recent activity summaries were available, but a fused comparison is not included while a participating personal baseline is learning.')
      }
      if (hasRecentPhone && wellnessContext.activity) {
        lines.push(isUsableState(motionState)
          ? `Most recent phone-motion summary: ${Math.round(wellnessContext.activity.current * 100)}% relative activity — ${currentComparison(wellnessContext.activity.status, wellnessContext.activity.difference_percent)}.`
          : `Most recent phone-motion summary: ${Math.round(wellnessContext.activity.current * 100)}% relative activity. A comparison is not included while the personal baseline is learning.`)
      }
      if (hasRecentSteps && wellnessContext.steps) {
        lines.push(isUsableState(stepsState)
          ? `Most recent steps summary: ${Math.round(wellnessContext.steps.current).toLocaleString()} steps — ${currentComparison(wellnessContext.steps.status, wellnessContext.steps.difference_percent)}.`
          : `Most recent steps summary: ${Math.round(wellnessContext.steps.current).toLocaleString()} steps. A comparison is not included while the personal baseline is learning.`)
      }
    } else {
      lines.push('No recent activity summary was available in the selected date range.')
    }
    sections.push({ heading: 'Activity', lines })
  }

  if (options.includeHeartRate) {
    const heartRateState = addMetricState('heart_rate')
    const lines: string[] = []
    if (isUsableState(heartRateState) && input.baseline.normal_heart_rate != null) {
      lines.push(`Personal heart-rate summary baseline: ${Math.round(input.baseline.normal_heart_rate)} bpm (${heartRateState}).`)
    } else {
      lines.push('Personal heart-rate baseline is still learning; no fallback/demo value is presented as personal data.')
    }
    if (wellnessContext.heart_rate && timestampInRange(timestamps.heartRate, options.startDate, options.endDate)) {
      lines.push(isUsableState(heartRateState)
        ? `Most recent compact heart-rate average: ${Math.round(wellnessContext.heart_rate.current)} bpm — ${currentComparison(wellnessContext.heart_rate.status, wellnessContext.heart_rate.difference_percent)}. This is an observation only; WithYou does not assess medical significance.`
        : `Most recent compact heart-rate average: ${Math.round(wellnessContext.heart_rate.current)} bpm. A comparison is not included while the personal baseline is learning. This is an observation only.`)
    } else {
      lines.push('No recent compact heart-rate summary was available in the selected date range.')
    }
    sections.push({ heading: 'Heart rate', lines })
  }

  const repeated = [...includedMetrics]
    .filter((metric) => adaptiveProfile.metrics[metric].state === 'adapting' && adaptiveProfile.metrics[metric].candidate_count >= 5)
    .map((metric) => `Repeated change observed in ${METRIC_LABELS[metric]}; the personal baseline is adapting gradually.`)
  if (repeated.length) sections.push({ heading: 'Repeated changes', lines: repeated })

  const selectedQualifications = [...includedMetrics]
    .map((metric) => adaptiveProfile.last_qualifications[metric])
    .filter((value) => value != null)
  const supportingSources = [...new Set([
    ...pattern.supporting_sources.map(readableSource),
    ...selectedQualifications.flatMap((item) => item.supporting_sources.map(readableSource)),
  ])]
  const conflictingSources = [...new Set(selectedQualifications.flatMap((item) => item.conflicting_sources.map(readableSource)))]
  if (pattern.activity_fusion.interpretation === 'mixed') {
    for (const source of pattern.activity_fusion.supporting_sources.map(readableSource)) {
      if (!conflictingSources.includes(source)) conflictingSources.push(source)
    }
  }
  const missingSources = [...new Set(pattern.missing_sources.map(readableSource))]
  sections.push({
    heading: 'Data confidence and sources',
    lines: [
      `Confidence: ${overallConfidence(selectedStates, options.includeActivity ? pattern.activity_fusion.confidence : undefined)}`,
      `Supporting sources: ${supportingSources.length ? supportingSources.join(', ') : 'none available'}.`,
      `Conflicting sources: ${conflictingSources.length ? conflictingSources.join(', ') : 'none identified'}.`,
      `Missing sources: ${missingSources.length ? missingSources.join(', ') : 'none'}. Missing data was not treated as a change.`,
    ],
  })

  const context = input.userContext?.trim()
  if (options.includeUserContext && context) {
    sections.push({ heading: 'User-provided context (verbatim)', lines: [context] })
  }

  sections.push({
    heading: 'Privacy note',
    lines: ['This report contains compact interpreted summaries and adaptive baseline state only. It does not contain raw Health Connect history, heart-rate samples, sleep stages, or full daily histories.'],
  })

  const partial: Omit<ClinicalSummary, 'text'> = {
    title: 'WithYou Clinical Summary',
    disclaimer: CLINICAL_SUMMARY_DISCLAIMER,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    dateRange: `${dateLabel(options.startDate)} to ${dateLabel(options.endDate)}`,
    sections,
    supportingSources,
    conflictingSources,
    missingSources,
  }
  return { ...partial, text: reportText(partial) }
}
