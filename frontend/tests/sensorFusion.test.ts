import assert from 'node:assert/strict'
import test from 'node:test'

import { DEMO_BASELINE } from '../src/db.ts'
import { analyzePatterns, buildWellnessContext } from '../src/patternAnalyzer.ts'
import type { BaselineProfile, SensorReading } from '../src/types.ts'

const personalBaseline: BaselineProfile = {
  ...DEMO_BASELINE,
  normal_daily_steps: 10_000,
  steps_baseline_source: 'health_connect',
}

function eveningTimestamp() {
  const date = new Date()
  date.setHours(20, 0, 0, 0)
  return date.toISOString()
}

function phoneActivity(value: number): SensorReading {
  return {
    timestamp: eveningTimestamp(),
    source: 'phone',
    sensor_type: 'activity',
    value,
    unit: 'relative',
    is_simulated: false,
    metadata: {},
  }
}

function watchSteps(value: number): SensorReading {
  return {
    timestamp: eveningTimestamp(),
    source: 'watch',
    sensor_type: 'steps',
    value,
    unit: 'count',
    is_simulated: false,
    metadata: {
      provider: 'health_connect',
      summary_kind: 'current',
      raw_history_uploaded: false,
    },
  }
}

function homeTemperature(): SensorReading {
  return {
    timestamp: eveningTimestamp(),
    source: 'arduino',
    sensor_type: 'temperature',
    value: 72,
    unit: 'fahrenheit',
    is_simulated: true,
    metadata: {},
  }
}

test('one activity source is used with normal confidence', () => {
  const pattern = analyzePatterns([phoneActivity(0.2)], personalBaseline)

  assert.equal(pattern.activity_fusion.interpretation, 'changed')
  assert.equal(pattern.activity_fusion.confidence, 'normal')
  assert.deepEqual(pattern.activity_fusion.supporting_sources, ['phone_motion'])
  assert.deepEqual(pattern.activity_fusion.missing_sources, ['watch_steps'])
  assert.equal(pattern.reasons.length, 1)
})

test('agreeing phone motion and watch steps increase confidence without duplicate alerts', () => {
  const pattern = analyzePatterns([phoneActivity(0.2), watchSteps(3000)], personalBaseline)

  assert.equal(pattern.activity_fusion.interpretation, 'changed')
  assert.equal(pattern.activity_fusion.confidence, 'high')
  assert.deepEqual(pattern.activity_fusion.supporting_sources, ['phone_motion', 'watch_steps'])
  assert.equal(pattern.reasons.filter((reason) => /activity|movement|steps/i.test(reason)).length, 1)
})

test('disagreeing activity sources produce a mixed interpretation without a strong alert', () => {
  const readings = [phoneActivity(0.2), watchSteps(10_000)]
  const pattern = analyzePatterns(readings, personalBaseline)
  const context = buildWellnessContext(readings, personalBaseline, pattern)

  assert.equal(pattern.activity_fusion.interpretation, 'mixed')
  assert.equal(pattern.activity_fusion.confidence, 'low')
  assert.equal(pattern.reasons.length, 0)
  assert.equal(pattern.status, 'normal')
  assert.equal(context.activity_fusion.interpretation, 'mixed')
})

test('extreme phone motion with normal watch steps remains mixed', () => {
  const pattern = analyzePatterns([phoneActivity(0.98), watchSteps(10_000)], personalBaseline)

  assert.equal(pattern.activity_fusion.interpretation, 'mixed')
  assert.equal(pattern.activity_fusion.confidence, 'low')
  assert.equal(pattern.reasons.length, 0)
})

test('home sensor context never substitutes for movement evidence', () => {
  const pattern = analyzePatterns([homeTemperature()], personalBaseline)

  assert.equal(pattern.activity_fusion.interpretation, 'unavailable')
  assert.deepEqual(pattern.supporting_sources, ['home_sensor'])
  assert.deepEqual(pattern.missing_sources, ['phone_motion', 'watch_steps'])
  assert.equal(pattern.reasons.length, 0)
})

test('missing all sources does not create an abnormal pattern', () => {
  const pattern = analyzePatterns([], personalBaseline)

  assert.equal(pattern.status, 'normal')
  assert.equal(pattern.activity_fusion.interpretation, 'unavailable')
  assert.deepEqual(pattern.supporting_sources, [])
  assert.deepEqual(pattern.missing_sources, ['phone_motion', 'watch_steps', 'home_sensor'])
})

test('legacy sound readings do not affect patterns or the compact context', () => {
  const sound: SensorReading = {
    timestamp: eveningTimestamp(),
    source: 'phone',
    sensor_type: 'sound_level',
    value: 0.99,
    unit: 'relative',
    is_simulated: false,
    metadata: { classification: 'loud' },
  }
  const pattern = analyzePatterns([sound], personalBaseline)
  const context = buildWellnessContext([sound], personalBaseline, pattern)

  assert.equal(pattern.status, 'normal')
  assert.deepEqual(pattern.reasons, [])
  assert.equal(context.environment.sound_level, 'unknown')
})
