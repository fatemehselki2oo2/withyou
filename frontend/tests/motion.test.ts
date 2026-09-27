import assert from 'node:assert/strict'
import test from 'node:test'

import { startMotionSession, type MotionFailureReason } from '../src/motion.ts'

type FakeWindow = {
  DeviceMotionEvent?: unknown
  addEventListener: () => void
  removeEventListener: () => void
  setInterval: () => number
  clearInterval: () => void
  setTimeout: () => number
  clearTimeout: () => void
}

function withFakeWindow(value: FakeWindow, run: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value })
  return run().finally(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
}

function fakeWindow(DeviceMotionEvent?: unknown): FakeWindow {
  const value: FakeWindow = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 2,
    clearTimeout: () => undefined,
  }
  if (DeviceMotionEvent !== undefined) value.DeviceMotionEvent = DeviceMotionEvent
  return value
}

test('reports unavailable when the browser has no motion API', async () => {
  await withFakeWindow(fakeWindow(), async () => {
    let failure: MotionFailureReason | null = null
    const session = await startMotionSession(() => undefined, (reason) => { failure = reason })
    assert.equal(session, null)
    assert.equal(failure, 'unavailable')
  })
})

test('keeps a denied phone in the permission-needed path', async () => {
  class MotionPermission {
    static requestPermission = async () => 'denied' as const
  }
  await withFakeWindow(fakeWindow(MotionPermission), async () => {
    let failure: MotionFailureReason | null = null
    const session = await startMotionSession(() => undefined, (reason) => { failure = reason })
    assert.equal(session, null)
    assert.equal(failure, 'permission_denied')
  })
})

test('granted permission starts a resumable motion session', async () => {
  let requests = 0
  let motionHandler: ((event: { acceleration: { x: number; y: number; z: number } }) => void) | undefined
  let intervalHandler: (() => void) | undefined
  class MotionPermission {
    static requestPermission = async () => {
      requests += 1
      return 'granted' as const
    }
  }
  const runtime = fakeWindow(MotionPermission)
  runtime.addEventListener = (_type?: string, handler?: unknown) => { motionHandler = handler as typeof motionHandler }
  runtime.setInterval = (handler?: unknown) => { intervalHandler = handler as typeof intervalHandler; return 1 }
  await withFakeWindow(runtime, async () => {
    const readings: number[] = []
    const session = await startMotionSession((reading) => readings.push(reading.activity_level), () => assert.fail('permission should be granted'))
    assert.ok(session)
    assert.equal(requests, 1)
    motionHandler?.({ acceleration: { x: 1, y: 1, z: 1 } })
    intervalHandler?.()
    assert.equal(readings.length, 1)
    session.stop()

    const resumed = await startMotionSession(
      () => undefined,
      () => assert.fail('resume should stay available'),
      { requestPermission: false },
    )
    assert.ok(resumed)
    assert.equal(requests, 1)
    resumed.stop()
  })
})
