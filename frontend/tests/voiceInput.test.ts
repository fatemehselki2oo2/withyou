import assert from 'node:assert/strict'
import test from 'node:test'

import { requestVoiceInputStream } from '../src/voiceInput.ts'

test('voice input requests microphone audio only when explicitly invoked', async () => {
  let requests = 0
  let requestedConstraints: MediaStreamConstraints | undefined
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          requests += 1
          requestedConstraints = constraints
          return {} as MediaStream
        },
      },
    },
  })

  try {
    assert.equal(requests, 0, 'importing voice input must not request permission')
    await requestVoiceInputStream()
    assert.equal(requests, 1)
    assert.deepEqual(requestedConstraints, { audio: true })
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})
