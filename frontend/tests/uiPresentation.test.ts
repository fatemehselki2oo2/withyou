import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSourceRailItems,
  buildTodayPresentation,
  formatPersonalDelta,
} from '../src/uiPresentation.ts'

test('source rail presents accurate text states without relying on color', () => {
  const items = buildSourceRailItems({
    phoneConnected: true,
    phoneDetail: 'Motion ready · sound optional',
    healthConnected: false,
    healthDetail: 'No Health Connect summary yet',
    homeState: 'offline',
    homeDetail: 'Pico W offline · last reading 42 sec ago',
    checkInDetail: 'Sleep and mood are available',
  })

  assert.deepEqual(items.map(({ label, state }) => [label, state]), [
    ['Phone', 'Connected'],
    ['Health', 'Not connected'],
    ['Home', 'Offline'],
    ['Check-ins', 'Available'],
  ])
  assert.match(items[2].detail, /last reading 42 sec ago/)
})

test('Today status shows a clean Start fresh state when no current data exists', () => {
  const result = buildTodayPresentation({
    hasCurrentData: false,
    baselineState: 'learning',
    patternStatus: 'normal',
    missingSourceCount: 3,
  })

  assert.equal(result.title, 'Start fresh with WithYou')
  assert.match(result.description, /Connect the sources you choose/)
  assert.equal(result.tone, 'empty')
})

test('Today status distinguishes learning from a qualified normal routine', () => {
  const learning = buildTodayPresentation({
    hasCurrentData: true,
    baselineState: 'learning',
    patternStatus: 'normal',
    missingSourceCount: 1,
  })
  const qualified = buildTodayPresentation({
    hasCurrentData: true,
    baselineState: 'qualified',
    patternStatus: 'normal',
    missingSourceCount: 1,
  })

  assert.equal(learning.title, 'I’m still learning your routine')
  assert.equal(qualified.title, 'Things look close to your usual routine')
  assert.match(qualified.description, /Missing sources were ignored/)
})

test('Today status keeps the existing meaningful-change reason', () => {
  const result = buildTodayPresentation({
    hasCurrentData: true,
    baselineState: 'qualified',
    patternStatus: 'changed',
    firstReason: 'Phone and Health agree that activity differs from your normal',
    missingSourceCount: 0,
  })

  assert.equal(result.title, 'A meaningful change was noticed')
  assert.equal(result.description, 'Phone and Health agree that activity differs from your normal')
})

test('baseline rows hide fallback comparisons while a metric is learning', () => {
  assert.equal(formatPersonalDelta(6.1, 7.3, 'learning', 'h', 1), 'Baseline still learning')
  assert.equal(formatPersonalDelta(null, 7.3, 'qualified', 'h', 1), 'No recent reading')
  assert.equal(formatPersonalDelta(6.1, 7.3, 'qualified', 'h', 1), '1.2 h lower')
  assert.equal(formatPersonalDelta(74, 68, 'adapting', 'bpm'), '6 bpm higher')
})
