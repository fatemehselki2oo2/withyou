import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HEALTH_BRIDGE_PACKAGE,
  healthBridgeIntentUrl,
  healthBridgeReturnState,
} from '../src/healthBridge.ts'

test('builds a package-scoped Android intent with a beginner-friendly web fallback', () => {
  const intent = healthBridgeIntentUrl('https://withyou-nine.vercel.app/today?source=health')

  assert.match(intent, /^intent:\/\/health\/connect#Intent;scheme=withyou;/)
  assert.match(intent, new RegExp(`package=${HEALTH_BRIDGE_PACKAGE}`))
  const encodedFallback = intent.match(/S\.browser_fallback_url=([^;]+);end$/)?.[1]
  assert.ok(encodedFallback)
  const fallback = new URL(decodeURIComponent(encodedFallback))
  assert.equal(fallback.origin, 'https://withyou-nine.vercel.app')
  assert.equal(fallback.searchParams.get('health_bridge'), 'not_installed')
})

test('recognizes bridge-not-installed and completed-sync returns', () => {
  assert.equal(healthBridgeReturnState('?health_bridge=not_installed'), 'not_installed')
  assert.equal(healthBridgeReturnState('?health_sync=complete'), 'sync_complete')
  assert.equal(healthBridgeReturnState('?other=value'), null)
})
