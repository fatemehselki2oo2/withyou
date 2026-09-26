import type { ActivityReading, ActivityState } from './types'

type PermissionedDeviceMotionEvent = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

const WINDOW_DURATION_MS = 3_000

function summarizeMotion(samples: number[]): Pick<ActivityReading, 'activity_level' | 'state'> {
  const rootMeanSquare = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
  const activityLevel = Math.min(1, rootMeanSquare / 4)
  let state: ActivityState = 'still'
  if (activityLevel >= 0.58) state = 'active'
  else if (activityLevel >= 0.18) state = 'walking'

  return {
    activity_level: Number(activityLevel.toFixed(2)),
    state,
  }
}

function motionMagnitude(event: DeviceMotionEvent): number | null {
  const acceleration = event.acceleration
  if (acceleration?.x != null && acceleration.y != null && acceleration.z != null) {
    return Math.sqrt(acceleration.x ** 2 + acceleration.y ** 2 + acceleration.z ** 2)
  }

  const withGravity = event.accelerationIncludingGravity
  if (withGravity?.x != null && withGravity.y != null && withGravity.z != null) {
    const total = Math.sqrt(withGravity.x ** 2 + withGravity.y ** 2 + withGravity.z ** 2)
    return Math.abs(total - 9.81)
  }

  return null
}

export interface MotionSession {
  stop: () => void
}

export async function startMotionSession(
  onReading: (reading: ActivityReading) => void,
  onUnavailable: (message: string) => void,
): Promise<MotionSession | null> {
  if (!('DeviceMotionEvent' in window)) {
    onUnavailable('Motion sensing is not available in this browser. Demo Mode is ready instead.')
    return null
  }

  const constructor = window.DeviceMotionEvent as PermissionedDeviceMotionEvent
  if (typeof constructor.requestPermission === 'function') {
    const permission = await constructor.requestPermission()
    if (permission !== 'granted') {
      onUnavailable('Motion permission was not granted. Demo Mode is ready instead.')
      return null
    }
  }

  let samples: number[] = []
  let receivedSample = false
  let stopped = false

  const handleMotion = (event: DeviceMotionEvent) => {
    const magnitude = motionMagnitude(event)
    if (magnitude == null || !Number.isFinite(magnitude)) return
    receivedSample = true
    samples.push(magnitude)
  }

  window.addEventListener('devicemotion', handleMotion)

  const interval = window.setInterval(() => {
    if (!samples.length) return
    const summary = summarizeMotion(samples)
    samples = []
    onReading({
      timestamp: new Date().toISOString(),
      source: 'phone',
      ...summary,
      is_simulated: false,
    })
  }, WINDOW_DURATION_MS)

  const availabilityTimeout = window.setTimeout(() => {
    if (!receivedSample && !stopped) {
      window.removeEventListener('devicemotion', handleMotion)
      window.clearInterval(interval)
      stopped = true
      onUnavailable('No motion readings arrived from this browser. Demo Mode is ready instead.')
    }
  }, 5_000)

  return {
    stop: () => {
      stopped = true
      window.removeEventListener('devicemotion', handleMotion)
      window.clearInterval(interval)
      window.clearTimeout(availabilityTimeout)
    },
  }
}

