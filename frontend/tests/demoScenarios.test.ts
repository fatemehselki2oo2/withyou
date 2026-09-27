import assert from 'node:assert/strict'
import test from 'node:test'
import { DEMO_BASELINE } from '../src/db.ts'
import {
  applySelectedDemoScenario,
  demoPresentationBaseline,
  EMPTY_DEMO_SCENARIO_STATE,
  readingsForRealLearning,
  selectDemoScenario,
} from '../src/demoScenarios.ts'
import { buildLearningInputs, createAdaptiveProfile, updateAdaptiveProfile } from '../src/adaptiveBaseline.ts'
import { analyzePatterns } from '../src/patternAnalyzer.ts'

test('selecting a demo does not apply readings until the explicit run action', () => {
  const selected = selectDemoScenario(EMPTY_DEMO_SCENARIO_STATE, 'low')
  assert.equal(selected.selected, 'low')
  assert.equal(selected.applied, null)

  const applied = applySelectedDemoScenario(selected, new Date('2026-09-27T20:00:00-04:00'))
  assert.equal(applied.applied?.id, 'low')
  assert.equal(applied.applied?.readings.length, 1)
  assert.equal(applied.applied?.readings[0].is_simulated, true)
  assert.equal(applied.applied?.readings[0].metadata.demo_only, true)
})

test('combined demo visibly produces a strong presentation-only interpretation', () => {
  const selected = selectDemoScenario(EMPTY_DEMO_SCENARIO_STATE, 'combined')
  const applied = applySelectedDemoScenario(selected, new Date('2026-09-27T20:00:00-04:00'))
  const pattern = analyzePatterns(applied.applied?.readings ?? [], demoPresentationBaseline(DEMO_BASELINE))

  assert.equal(pattern.status, 'changed')
  assert.equal(pattern.severity, 'moderate')
  assert.equal(pattern.activity_fusion.confidence, 'high')
  assert.ok(pattern.reasons.length >= 4)
})

test('demo readings are excluded from the real adaptive learning inputs', () => {
  const selected = selectDemoScenario(EMPTY_DEMO_SCENARIO_STATE, 'combined')
  const applied = applySelectedDemoScenario(selected, new Date('2026-09-27T20:00:00-04:00'))
  const demoReadings = applied.applied?.readings ?? []
  const pattern = analyzePatterns(demoReadings, demoPresentationBaseline(DEMO_BASELINE))
  const learning = buildLearningInputs(
    readingsForRealLearning(demoReadings),
    { current: {}, baseline: {} },
    pattern.activity_fusion,
  )
  const profile = createAdaptiveProfile(DEMO_BASELINE, new Date('2026-09-27T20:00:00-04:00'))

  assert.deepEqual(learning, { inputs: [], qualifications: {} })
  assert.deepEqual(readingsForRealLearning(demoReadings), [])
  assert.deepEqual(updateAdaptiveProfile(profile, learning), profile)
})
