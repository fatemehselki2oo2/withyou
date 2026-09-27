export const HEALTH_BRIDGE_PACKAGE = 'com.withyou.healthbridge'
export const HEALTH_BRIDGE_INSTALL_HELP_URL = 'https://github.com/fatemehselki2oo2/withyou/tree/main/android'

export function healthBridgeIntentUrl(currentUrl: string): string {
  const fallback = new URL(currentUrl)
  fallback.searchParams.delete('health_sync')
  fallback.searchParams.set('health_bridge', 'not_installed')
  return `intent://health/connect#Intent;scheme=withyou;package=${HEALTH_BRIDGE_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallback.toString())};end`
}

export function healthBridgeReturnState(search: string): 'not_installed' | 'sync_complete' | null {
  const params = new URLSearchParams(search)
  if (params.get('health_bridge') === 'not_installed') return 'not_installed'
  if (params.get('health_sync') === 'complete') return 'sync_complete'
  return null
}
