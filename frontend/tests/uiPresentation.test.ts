import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSourceRailItems,
  buildTodayPresentation,
  formatPersonalDelta,
  healthPanelVisibility,
} from '../src/uiPresentation.ts'

test('source rail presents accurate text states without relying on color', () => {
  const items = buildSourceRailItems({
    phoneState: 'connected',
    phoneDetail: 'Updating motion automatically',
    healthState: 'not_connected',
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

test('source rail distinguishes permission, unavailable, and sync-needed states', () => {
  const items = buildSourceRailItems({
    phoneState: 'unavailable',
    phoneDetail: 'Motion is unavailable here',
    healthState: 'sync_needed',
    healthDetail: 'Open the Android bridge to sync',
    homeState: 'not_paired',
    homeDetail: 'Connect with a demo code',
    checkInDetail: 'Sleep and mood are available',
  })

  assert.equal(items[0].state, 'Unavailable')
  assert.equal(items[0].tone, 'muted')
  assert.equal(items[1].state, 'Sync needed')
  assert.equal(items[1].tone, 'attention')
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

  assert.equal(learning.title, 'Learning your routine')
  assert.match(learning.description, /initial 30-day learning period/)
  assert.equal(qualified.title, 'Things look close to your usual routine')
  assert.match(qualified.description, /Missing sources were ignored/)
})

test('learning state takes precedence over a provisional changed pattern', () => {
  const result = buildTodayPresentation({
    hasCurrentData: true,
    baselineState: 'learning',
    patternStatus: 'changed',
    firstReason: 'Phone motion differs meaningfully from your normal',
    missingSourceCount: 1,
  })

  assert.equal(result.title, 'Learning your routine')
  assert.doesNotMatch(result.description, /meaningful change|differs meaningfully/i)
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

test('connected Android Health keeps summaries and management available', () => {
  assert.deepEqual(healthPanelVisibility({
    healthState: 'connected',
    isAndroid: true,
    isDesktop: false,
    helperMissing: false,
  }), {
    showSummaries: true,
    showAndroidManagement: true,
    showPrimaryInstall: false,
    showDesktopManagementNote: false,
  })
})

test('disconnected Android Health keeps setup and missing-helper recovery distinct', () => {
  const helperAvailable = healthPanelVisibility({
    healthState: 'not_connected',
    isAndroid: true,
    isDesktop: false,
    helperMissing: false,
  })
  const helperMissing = healthPanelVisibility({
    healthState: 'not_connected',
    isAndroid: true,
    isDesktop: false,
    helperMissing: true,
  })

  assert.equal(helperAvailable.showAndroidManagement, true)
  assert.equal(helperAvailable.showPrimaryInstall, false)
  assert.equal(helperMissing.showAndroidManagement, false)
  assert.equal(helperMissing.showPrimaryInstall, true)
})

test('connected desktop Health shows summaries without Android-only actions', () => {
  const result = healthPanelVisibility({
    healthState: 'connected',
    isAndroid: false,
    isDesktop: true,
    helperMissing: false,
  })

  assert.equal(result.showSummaries, true)
  assert.equal(result.showAndroidManagement, false)
  assert.equal(result.showDesktopManagementNote, true)
})
