import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HOME_SENSOR_POLL_MS,
  homeSensorFreshness,
  homeSensorValueLabel,
  latestHomeSensorReadings,
  startHomeSensorPolling,
} from '../src/homeSensor.ts'
import type { HomeSensorSessionResponse, SensorReading, SensorType } from '../src/types.ts'

function reading(sensorType: SensorType, value: number, timestamp: string): SensorReading {
  return {
    id: `${sensorType}-${timestamp}`,
    demo_session_id: 'WITHYOU1',
    device_id: 'pico-w-demo-01',
    timestamp,
    source: 'arduino',
    sensor_type: sensorType,
    value,
    unit: sensorType === 'temperature' ? 'fahrenheit' : sensorType === 'humidity' ? 'percent' : 'lux',
    is_simulated: true,
    metadata: { hardware_path: 'real', value_source: 'simulated' },
  }
}

function response(value = 71.5): HomeSensorSessionResponse {
  return {
    status: 'ok',
    demo_session_id: 'WITHYOU1',
    device_id: 'pico-w-demo-01',
    updated_at: '2026-09-26T17:00:00Z',
    expires_at: '2026-09-26T21:00:00Z',
    readings: [reading('temperature', value, '2026-09-26T17:00:00Z')],
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

test('starts an immediate fetch when a demo session connects', async () => {
  let fetchCount = 0
  let intervalMilliseconds = 0
  const stop = startHomeSensorPolling('WITHYOU1', {
    fetcher: async () => {
      fetchCount += 1
      return response()
    },
    onResult: () => undefined,
    onError: () => assert.fail('fetch should succeed'),
    setIntervalFn: (_callback, milliseconds) => {
      intervalMilliseconds = milliseconds
      return 1
    },
    clearIntervalFn: () => undefined,
  })

  assert.equal(fetchCount, 1)
  assert.equal(intervalMilliseconds, HOME_SENSOR_POLL_MS)
  await settle()
  stop()
})

test('automatically polls the existing session endpoint every interval', async () => {
  let fetchCount = 0
  let scheduledPoll: (() => void) | undefined
  const stop = startHomeSensorPolling('WITHYOU1', {
    fetcher: async () => {
      fetchCount += 1
      return response()
    },
    onResult: () => undefined,
    onError: () => assert.fail('fetch should succeed'),
    setIntervalFn: (callback) => {
      scheduledPoll = callback
      return 1
    },
    clearIntervalFn: () => undefined,
  })

  await settle()
  scheduledPoll?.()
  await settle()
  assert.equal(HOME_SENSOR_POLL_MS, 3_000)
  assert.equal(fetchCount, 2)
  stop()
})

test('disconnect cleanup stops automatic session polling', async () => {
  let fetchCount = 0
  let cleared = false
  let scheduledPoll: (() => void) | undefined
  const stop = startHomeSensorPolling('WITHYOU1', {
    fetcher: async () => {
      fetchCount += 1
      return response()
    },
    onResult: () => undefined,
    onError: () => assert.fail('fetch should succeed'),
    setIntervalFn: (callback) => {
      scheduledPoll = callback
      return 42
    },
    clearIntervalFn: (handle) => {
      assert.equal(handle, 42)
      cleared = true
    },
  })

  await settle()
  stop()
  scheduledPoll?.()
  await settle()
  assert.equal(cleared, true)
  assert.equal(fetchCount, 1)
})

test('selects the latest Pico value for each sensor type, never a baseline', () => {
  const values = latestHomeSensorReadings([
    reading('temperature', 70, '2026-09-26T16:59:00Z'),
    reading('temperature', 71.5, '2026-09-26T17:00:00Z'),
    reading('humidity', 44, '2026-09-26T17:00:00Z'),
    reading('light', 340, '2026-09-26T17:00:00Z'),
    { ...reading('temperature', 72, '2026-09-26T17:01:00Z'), metadata: { summary_kind: 'baseline' } },
    { ...reading('light', 999, '2026-09-26T17:02:00Z'), source: 'phone' },
  ])

  assert.deepEqual(values.map((value) => [value.sensor_type, value.value]), [
    ['temperature', 71.5],
    ['humidity', 44],
    ['light', 340],
  ])
})

test('marks a Pico session offline after the freshness timeout', () => {
  const updatedAt = '2026-09-26T17:00:00Z'
  const live = homeSensorFreshness(updatedAt, new Date('2026-09-26T17:00:29Z').getTime())
  const offline = homeSensorFreshness(updatedAt, new Date('2026-09-26T17:00:30Z').getTime())

  assert.equal(live.state, 'live')
  assert.equal(live.label, 'Live Pico W · updated 29 sec ago')
  assert.equal(offline.state, 'offline')
  assert.equal(offline.label, 'Pico W offline · last reading 30 sec ago')
})

test('labels retained offline values as the last stale Pico reading', () => {
  const offline = homeSensorFreshness('2026-09-26T17:00:00Z', new Date('2026-09-26T17:01:00Z').getTime())

  assert.equal(homeSensorValueLabel(offline, true), 'Last Pico reading · stale')
  assert.equal(homeSensorValueLabel(offline, false), 'Awaiting Pico reading')
})
