import { apiUrl } from './api'
import type { HomeSensorSessionResponse } from './types'

export const HOME_SENSOR_POLL_MS = 5_000
export const HOME_SENSOR_RECENT_MS = 90_000

export function normalizeDemoCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
}

export function isValidDemoCode(value: string) {
  return /^[A-Z0-9]{6,12}$/.test(value)
}

export async function fetchLatestHomeSensor(code: string): Promise<HomeSensorSessionResponse> {
  const response = await fetch(apiUrl('/api/sensors/demo-sessions/latest'), {
    cache: 'no-store',
    headers: { 'X-Demo-Session-ID': code },
  })
  if (!response.ok) {
    const error = new Error(response.status === 404 ? 'demo_session_missing' : 'demo_session_unavailable')
    throw error
  }
  return await response.json() as HomeSensorSessionResponse
}
