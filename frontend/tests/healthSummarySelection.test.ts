import assert from 'node:assert/strict'
import test from 'node:test'

import { DEMO_BASELINE } from '../src/db.ts'
import {
  applyHealthConnectBaselines,
  currentHealthReadings,
  selectHealthConnectSummaries,
} from '../src/healthSummarySelection.ts'
import { analyzePatterns, latestReading } from '../src/patternAnalyzer.ts'
import type { SensorReading } from '../src/types.ts'

function summary(
  sensorType: 'steps' | 'sleep' | 'heart_rate',
  kind: 'current' | 'baseline',
  value: number,
  timestamp: string,
): SensorReading {
  return {
    timestamp,
    source: 'watch',
    sensor_type: sensorType,
    value,
    unit: sensorType === 'heart_rate' ? 'bpm' : sensorType === 'sleep' ? 'hours' : 'count',
    is_simulated: false,
    metadata: {
      provider: 'health_connect',
      summary_kind: kind,
      raw_history_uploaded: false,
    },
  }
}

test('current and baseline summaries remain in separate slots', () => {
  const current = summary('sleep', 'current', 6.8, '2026-09-26T08:00:00Z')
  const baseline = summary('sleep', 'baseline', 7.4, '2026-09-26T12:00:00Z')
  const selected = selectHealthConnectSummaries([current, baseline])

  assert.equal(selected.current.sleep?.value, 6.8)
  assert.equal(selected.baseline.sleep?.value, 7.4)
  assert.deepEqual(currentHealthReadings(selected), [current])
})

test('fallback demo values remain when Health Connect is unavailable', () => {
  const effective = applyHealthConnectBaselines(DEMO_BASELINE, selectHealthConnectSummaries([]))

  assert.equal(effective.normal_sleep_duration, 7.5)
  assert.equal(effective.normal_daily_steps, null)
  assert.equal(effective.normal_heart_rate, null)
  assert.equal(effective.sleep_baseline_source, 'demo')
})

test('Health Connect baselines populate personal baseline fields', () => {
  const selected = selectHealthConnectSummaries([
    summary('steps', 'baseline', 7200, '2026-09-26T12:00:00Z'),
    summary('sleep', 'baseline', 7.2, '2026-09-26T12:00:00Z'),
    summary('heart_rate', 'baseline', 68, '2026-09-26T12:00:00Z'),
  ])
  const effective = applyHealthConnectBaselines(DEMO_BASELINE, selected)

  assert.equal(effective.normal_daily_steps, 7200)
  assert.equal(effective.normal_sleep_duration, 7.2)
  assert.equal(effective.normal_heart_rate, 68)
  assert.equal(effective.sleep_baseline_source, 'health_connect')
})

test('a newer baseline can never become the latest current reading', () => {
  const current = summary('sleep', 'current', 6.8, '2026-09-26T08:00:00Z')
  const newerBaseline = summary('sleep', 'baseline', 7.4, '2026-09-26T12:00:00Z')

  assert.equal(latestReading([current, newerBaseline], 'sleep')?.value, 6.8)
})

test('personal sleep baseline replaces the demo fallback in comparisons', () => {
  const current = summary('sleep', 'current', 5, '2026-09-26T08:00:00Z')
  const selected = selectHealthConnectSummaries([
    summary('sleep', 'baseline', 6.5, '2026-09-26T12:00:00Z'),
  ])
  const personalBaseline = applyHealthConnectBaselines(DEMO_BASELINE, selected)

  assert.match(analyzePatterns([current], DEMO_BASELINE).reasons[0], /Sleep was/)
  assert.equal(analyzePatterns([current], personalBaseline).reasons.length, 0)
})
