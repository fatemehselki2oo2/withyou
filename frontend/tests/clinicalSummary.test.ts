import assert from 'node:assert/strict'
import test from 'node:test'

import { createAdaptiveProfile } from '../src/adaptiveBaseline.ts'
import { generateClinicalSummary } from '../src/clinicalSummary.ts'
import { DEMO_BASELINE } from '../src/db.ts'
import type { BaselineProfile, PatternAnalysis, WellnessContext } from '../src/types.ts'

const personalBaseline: BaselineProfile = {
  ...DEMO_BASELINE,
  normal_activity_level: 0.62,
  normal_sleep_duration: 7.2,
  normal_daily_steps: 7200,
  normal_heart_rate: 68,
  sleep_baseline_source: 'adaptive',
  steps_baseline_source: 'adaptive',
  heart_rate_baseline_source: 'adaptive',
}

const pattern: PatternAnalysis = {
  status: 'changed',
  severity: 'moderate',
  reasons: ['Available movement sources agree that activity differs meaningfully from your normal'],
  check_in_recommended: true,
  activity_fusion: {
    interpretation: 'changed',
    confidence: 'high',
    supporting_sources: ['phone_motion', 'watch_steps'],
    missing_sources: [],
    note: 'Sources agree.',
  },
  supporting_sources: ['phone_motion', 'watch_steps'],
  missing_sources: ['home_sensor'],
}

const context: WellnessContext = {
  activity: { current: 0.34, baseline: 0.62, difference_percent: -45.2, status: 'changed' },
  sleep: { hours: 5.8, baseline_hours: 7.2, status: 'normal' },
  steps: { current: 4100, baseline: 7200, difference_percent: -43.1, status: 'changed' },
  heart_rate: { current: 80, baseline: 68, difference_percent: 17.6, status: 'changed' },
  environment: { temperature: null, temperature_source: null, humidity: null, light: null, sound_level: 'unknown' },
  mood: null,
  activity_fusion: pattern.activity_fusion,
  supporting_sources: pattern.supporting_sources,
  missing_sources: pattern.missing_sources,
  baseline_state: 'qualified',
  baseline_states: {},
  data_confidence: {},
  overall_pattern_status: 'changed',
  severity: 'moderate',
  reasons: pattern.reasons,
  check_in_recommended: true,
}

function input() {
  const profile = createAdaptiveProfile(personalBaseline)
  Object.values(profile.metrics).forEach((metric) => {
    metric.state = 'qualified'
    metric.sample_count = 30
    metric.recent_qualified_day_count = 30
  })
  profile.metrics.sleep_duration.state = 'adapting'
  profile.metrics.sleep_duration.candidate_count = 5
  profile.last_qualifications = {
    phone_motion: {
      confidence: 'high', qualified_for_baseline: true,
      supporting_sources: ['phone_motion', 'watch_steps'], conflicting_sources: [], reason: 'Qualified.',
    },
  }
  return {
    options: {
      startDate: '2026-09-01', endDate: '2026-09-30',
      includeSleep: true, includeActivity: true, includeHeartRate: true, includeUserContext: true,
    },
    baseline: personalBaseline,
    adaptiveProfile: profile,
    pattern,
    wellnessContext: context,
    timestamps: {
      sleep: '2026-09-25T08:00:00Z', phoneActivity: '2026-09-25T20:00:00Z',
      steps: '2026-09-25T20:00:00Z', heartRate: '2026-09-25T20:00:00Z',
    },
    userContext: 'Night-shift schedule; discuss recent schedule change.',
    generatedAt: '2026-09-26T12:00:00Z',
  }
}

test('uses existing qualified/adaptive interpretations and marks repeated changes', () => {
  const report = generateClinicalSummary(input())

  assert.match(report.text, /Personal baseline sleep duration: 7\.2 hours \(adapting\)/)
  assert.match(report.text, /Recent fused activity was different from personal baseline \(high confidence\)/)
  assert.match(report.text, /Personal heart-rate summary baseline: 68 bpm \(qualified\)/)
  assert.match(report.text, /Repeated change observed in sleep duration/)
  assert.match(report.text, /across 5 qualified days/)
  assert.match(report.text, /At a glance/)
  assert.match(report.text, /What changed:/)
  assert.match(report.text, /How long/)
  assert.match(report.text, /Supporting sources: phone motion, watch steps/)
  assert.match(report.text, /For discussion with a healthcare professional — not a diagnosis/)
})

test('does not present learning fallback values as personal baselines', () => {
  const value = input()
  value.adaptiveProfile.metrics.sleep_duration.state = 'learning'
  value.adaptiveProfile.metrics.steps.state = 'learning'
  value.adaptiveProfile.metrics.phone_motion.state = 'learning'
  value.adaptiveProfile.metrics.heart_rate.state = 'learning'
  const report = generateClinicalSummary(value)

  assert.match(report.text, /still learning/)
  assert.doesNotMatch(report.text, /Personal baseline sleep duration: 7\.2/)
  assert.doesNotMatch(report.text, /Personal watch-steps baseline: 7,200/)
  assert.doesNotMatch(report.text, /Personal heart-rate summary baseline: 68/)
})

test('honors date and context choices without exposing raw health fields', () => {
  const value = input()
  value.options.endDate = '2026-09-10'
  value.options.includeUserContext = false
  const report = generateClinicalSummary(value)
  const serialized = JSON.stringify(report)

  assert.match(report.text, /No recent completed sleep summary was available/)
  assert.doesNotMatch(report.text, /Night-shift schedule/)
  assert.doesNotMatch(serialized, /heart_rate_samples|sleep_stages|daily_values|raw_history/)
  assert.match(report.text, /compact interpreted summaries and adaptive baseline state only/)
})
