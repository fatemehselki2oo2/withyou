import { apiUrl } from './api.ts'
import type { HomeSensorSessionResponse, SensorReading, SensorType } from './types.ts'

export const HOME_SENSOR_POLL_MS = 3_000
export const HOME_SENSOR_RECENT_MS = 30_000

const ENVIRONMENT_TYPES: SensorType[] = ['temperature', 'humidity', 'light']

export interface HomeSensorFreshness {
  state: 'waiting' | 'live' | 'offline'
  ageSeconds: number | null
  label: string
}

interface HomeSensorPollingOptions {
  fetcher?: (code: string) => Promise<HomeSensorSessionResponse>
  onResult: (result: HomeSensorSessionResponse) => void | Promise<void>
  onError: (error: unknown) => void
  setIntervalFn?: (callback: () => void, milliseconds: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
}

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

/** Selects the newest direct Pico value for each environmental sensor type. */
export function latestHomeSensorReadings(readings: SensorReading[]): SensorReading[] {
  const latest = new Map<SensorType, SensorReading>()
  for (const reading of readings) {
    if (
      reading.source !== 'arduino'
      || !ENVIRONMENT_TYPES.includes(reading.sensor_type)
      || reading.metadata.summary_kind === 'baseline'
    ) continue
    const previous = latest.get(reading.sensor_type)
    if (!previous || new Date(reading.timestamp).getTime() > new Date(previous.timestamp).getTime()) {
      latest.set(reading.sensor_type, reading)
    }
  }
  return ENVIRONMENT_TYPES.flatMap((sensorType) => {
    const reading = latest.get(sensorType)
    return reading ? [reading] : []
  })
}

export function homeSensorFreshness(updatedAt: string | null, now = Date.now()): HomeSensorFreshness {
  const updatedTime = updatedAt ? new Date(updatedAt).getTime() : Number.NaN
  if (!Number.isFinite(updatedTime)) {
    return { state: 'waiting', ageSeconds: null, label: 'Waiting for the first Pico W reading…' }
  }
  const ageSeconds = Math.max(0, Math.floor((now - updatedTime) / 1000))
  if (now - updatedTime < HOME_SENSOR_RECENT_MS) {
    return { state: 'live', ageSeconds, label: `Live Pico W · updated ${ageSeconds} sec ago` }
  }
  return { state: 'offline', ageSeconds, label: `Pico W offline · last reading ${ageSeconds} sec ago` }
}

export function homeSensorValueLabel(freshness: HomeSensorFreshness, hasReading: boolean): string {
  if (!hasReading) return 'Awaiting Pico reading'
  return freshness.state === 'live' ? 'Latest Pico reading' : 'Last Pico reading · stale'
}

/**
 * Starts one immediate request, then refreshes the existing session endpoint.
 * The returned cleanup stops future callbacks when the user disconnects/unmounts.
 */
export function startHomeSensorPolling(code: string, options: HomeSensorPollingOptions): () => void {
  const fetcher = options.fetcher ?? fetchLatestHomeSensor
  const setIntervalFn = options.setIntervalFn ?? ((callback, milliseconds) => window.setInterval(callback, milliseconds))
  const clearIntervalFn = options.clearIntervalFn ?? ((handle) => window.clearInterval(handle as number))
  let active = true
  let polling = false

  const poll = async () => {
    if (!active || polling) return
    polling = true
    try {
      const result = await fetcher(code)
      if (active) await options.onResult(result)
    } catch (error) {
      if (active) options.onError(error)
    } finally {
      polling = false
    }
  }

  void poll()
  const interval = setIntervalFn(() => void poll(), HOME_SENSOR_POLL_MS)
  return () => {
    active = false
    clearIntervalFn(interval)
  }
}
