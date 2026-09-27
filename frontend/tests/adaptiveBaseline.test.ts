import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyAdaptiveBaseline,
  buildLearningInputs,
  createAdaptiveProfile,
  restoreAdaptiveProfile,
  updateAdaptiveProfile,
  type AdaptiveBaselineProfile,
} from '../src/adaptiveBaseline.ts'
import { DEMO_BASELINE } from '../src/db.ts'
import type { SelectedHealthSummaries } from '../src/healthSummarySelection.ts'
import { analyzePatterns } from '../src/patternAnalyzer.ts'
import type { ActivityFusionAnalysis, SensorReading } from '../src/types.ts'

const unavailableFusion: ActivityFusionAnalysis = {
  interpretation: 'unavailable',
  confidence: 'none',
  supporting_sources: [],
  missing_sources: ['phone_motion', 'watch_steps'],
  note: 'No movement data.',
}

function qualifiedProfile(): AdaptiveBaselineProfile {
  const profile = createAdaptiveProfile(DEMO_BASELINE)
  Object.values(profile.metrics).forEach((metric) => {
    metric.state = 'qualified'
    metric.sample_count = 30
    metric.recent_qualified_day_count = 30
  })
  profile.metrics.phone_motion.standard_deviation = 0.03
  profile.metrics.sleep_duration.standard_deviation = 0.4
  profile.metrics.sleep_start.standard_deviation = 30
  profile.metrics.wake_time.standard_deviation = 30
  return profile
}

function phoneReading(day: string, value: number): SensorReading {
  return {
    timestamp: `${day}T20:00:00Z`,
    source: 'phone',
    sensor_type: 'activity',
    value,
    unit: 'relative',
    is_simulated: false,
    metadata: {},
  }
}

function sleepReading(day: string, startHour: number, wakeHour: number): SensorReading {
  const startDay = new Date(`${day}T12:00:00Z`)
  startDay.setUTCDate(startDay.getUTCDate() - 1)
  const start = `${startDay.toISOString().slice(0, 10)}T${String(startHour).padStart(2, '0')}:00:00Z`
  return {
    timestamp: `${day}T${String(wakeHour).padStart(2, '0')}:00:00Z`,
    source: 'watch',
    sensor_type: 'sleep',
    value: (24 - startHour + wakeHour) % 24,
    unit: 'hours',
    is_simulated: false,
    metadata: {
      provider: 'health_connect',
      summary_kind: 'current',
      raw_history_uploaded: false,
      sleep_start: start,
      wake_time: `${day}T${String(wakeHour).padStart(2, '0')}:00:00Z`,
    },
  }
}

function healthWithCurrentSleep(reading: SensorReading): SelectedHealthSummaries {
  return { current: { sleep: reading }, baseline: {} }
}

test('one abnormal day does not move a qualified phone baseline', () => {
  const profile = qualifiedProfile()
  const before = profile.metrics.phone_motion.mean
  const fusion: ActivityFusionAnalysis = {
    interpretation: 'changed', confidence: 'normal', supporting_sources: ['phone_motion'],
    missing_sources: ['watch_steps'], note: 'Phone only.',
  }
  const learning = buildLearningInputs([phoneReading('2026-09-01', 0.98)], { current: {}, baseline: {} }, fusion)
  const after = updateAdaptiveProfile(profile, learning)

  assert.equal(after.metrics.phone_motion.mean, before)
  assert.equal(after.metrics.phone_motion.candidate_count, 1)
  assert.equal(after.last_qualifications.phone_motion.qualified_for_baseline, false)
  assert.match(after.last_qualifications.phone_motion.reason, /Statistical outlier/)
})

test('conflicting extreme phone motion is not qualified for baseline learning', () => {
  const profile = qualifiedProfile()
  const fusion: ActivityFusionAnalysis = {
    interpretation: 'mixed', confidence: 'low', supporting_sources: ['phone_motion', 'watch_steps'],
    missing_sources: [], note: 'Conflict.',
  }
  const learning = buildLearningInputs([phoneReading('2026-09-02', 0.98)], { current: {}, baseline: {} }, fusion)
  const after = updateAdaptiveProfile(profile, learning)

  assert.equal(learning.qualifications.phone_motion.qualified_for_baseline, false)
  assert.deepEqual(learning.qualifications.phone_motion.conflicting_sources, ['watch_steps'])
  assert.equal(after.metrics.phone_motion.mean, profile.metrics.phone_motion.mean)
})

test('agreeing phone and watch evidence increases learning confidence', () => {
  const fusion: ActivityFusionAnalysis = {
    interpretation: 'normal', confidence: 'high', supporting_sources: ['phone_motion', 'watch_steps'],
    missing_sources: [], note: 'Agreement.',
  }
  const learning = buildLearningInputs([phoneReading('2026-09-03', 0.66)], { current: {}, baseline: {} }, fusion)

  assert.equal(learning.qualifications.phone_motion.confidence, 'high')
  assert.equal(learning.qualifications.phone_motion.qualified_for_baseline, true)
})

test('partial current-day steps are excluded from baseline learning', () => {
  const currentSteps: SensorReading = {
    timestamp: '2026-09-04T14:00:00Z', source: 'watch', sensor_type: 'steps', value: 3200,
    unit: 'count', is_simulated: false,
    metadata: { provider: 'health_connect', summary_kind: 'current', raw_history_uploaded: false },
  }
  const learning = buildLearningInputs([], { current: { steps: currentSteps }, baseline: {} }, unavailableFusion)

  assert.equal(learning.qualifications.steps_current.qualified_for_baseline, false)
  assert.equal(learning.inputs.some((input) => input.metric === 'steps'), false)
})

test('repeated sleep schedule shifts gradually using circular clock time', () => {
  let profile = qualifiedProfile()
  const initialStart = profile.metrics.sleep_start.mean
  const initialWake = profile.metrics.wake_time.mean

  for (let dayIndex = 1; dayIndex <= 21; dayIndex += 1) {
    const day = `2026-09-${String(dayIndex).padStart(2, '0')}`
    const sleep = sleepReading(day, 22, 6)
    const learning = buildLearningInputs([sleep], healthWithCurrentSleep(sleep), unavailableFusion)
    profile = updateAdaptiveProfile(profile, learning)
  }

  const updatedStart = profile.metrics.sleep_start.mean
  const updatedWake = profile.metrics.wake_time.mean
  assert.ok(updatedStart != null && initialStart != null && updatedStart > initialStart)
  assert.ok(updatedStart! < 1440)
  assert.ok(updatedWake != null && initialWake != null && updatedWake < initialWake)
  assert.ok(['adapting', 'qualified'].includes(profile.metrics.sleep_start.state))
})

test('an outlier streak must repeat before the baseline begins adapting', () => {
  let profile = qualifiedProfile()
  const original = profile.metrics.sleep_duration.mean

  for (let dayIndex = 1; dayIndex <= 4; dayIndex += 1) {
    const day = `2026-08-${String(dayIndex).padStart(2, '0')}`
    const sleep = sleepReading(day, 2, 6)
    profile = updateAdaptiveProfile(
      profile,
      buildLearningInputs([sleep], healthWithCurrentSleep(sleep), unavailableFusion),
    )
  }
  assert.equal(profile.metrics.sleep_duration.mean, original)

  const fifth = sleepReading('2026-08-05', 2, 6)
  profile = updateAdaptiveProfile(
    profile,
    buildLearningInputs([fifth], healthWithCurrentSleep(fifth), unavailableFusion),
  )
  assert.equal(profile.metrics.sleep_duration.state, 'adapting')
  assert.ok(profile.metrics.sleep_duration.mean! < original!)
})

test('adaptive profile survives serialization and restoration', () => {
  const profile = qualifiedProfile()
  profile.metrics.steps.mean = 8123
  profile.metrics.steps.last_updated = '2026-09-20'
  const saved = JSON.parse(JSON.stringify(profile)) as AdaptiveBaselineProfile
  const restored = restoreAdaptiveProfile(saved, DEMO_BASELINE)

  assert.equal(restored.metrics.steps.mean, 8123)
  assert.equal(restored.metrics.steps.last_updated, '2026-09-20')
  assert.equal(applyAdaptiveBaseline(DEMO_BASELINE, restored).normal_daily_steps, 8123)
})

test('a repeated pattern eventually becomes normal instead of alerting forever', () => {
  let profile = qualifiedProfile()
  const first = sleepReading('2026-07-01', 2, 6)
  assert.match(analyzePatterns([first], DEMO_BASELINE).reasons[0], /Sleep was/)

  for (let dayIndex = 1; dayIndex <= 21; dayIndex += 1) {
    const day = `2026-07-${String(dayIndex).padStart(2, '0')}`
    const sleep = sleepReading(day, 2, 6)
    profile = updateAdaptiveProfile(
      profile,
      buildLearningInputs([sleep], healthWithCurrentSleep(sleep), unavailableFusion),
    )
  }

  const effective = applyAdaptiveBaseline(DEMO_BASELINE, profile)
  const latest = sleepReading('2026-07-22', 2, 6)
  assert.equal(analyzePatterns([latest], effective).reasons.some((reason) => /Sleep was/.test(reason)), false)
  assert.ok(effective.normal_sleep_duration < DEMO_BASELINE.normal_sleep_duration)
})
