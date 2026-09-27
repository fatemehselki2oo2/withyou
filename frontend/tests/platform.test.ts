import assert from 'node:assert/strict'
import test from 'node:test'

import { platformInfo } from '../src/platform.ts'

test('recognizes Android as mobile and Health Helper capable', () => {
  assert.deepEqual(platformInfo({ userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S928U) Mobile' }), {
    isAndroid: true,
    isMobile: true,
    isDesktop: false,
  })
})

test('recognizes iPhone as mobile without claiming Android Health Connect support', () => {
  assert.deepEqual(platformInfo({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile' }), {
    isAndroid: false,
    isMobile: true,
    isDesktop: false,
  })
})

test('recognizes a desktop browser as a viewing portal', () => {
  assert.deepEqual(platformInfo({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140' }), {
    isAndroid: false,
    isMobile: false,
    isDesktop: true,
  })
})

test('uses userAgentData mobile when available', () => {
  assert.equal(platformInfo({
    userAgent: 'Mozilla/5.0',
    userAgentData: { mobile: true, platform: 'Android' },
  }).isDesktop, false)
})
