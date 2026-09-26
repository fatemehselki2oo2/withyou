import type { SensorReading } from './types'

const MEASUREMENT_MS = 4_000

export type SoundClassification = 'quiet' | 'normal' | 'loud'

function classify(level: number): SoundClassification {
  if (level < 0.16) return 'quiet'
  if (level < 0.62) return 'normal'
  return 'loud'
}

export async function measureEnvironmentSound(
  onProgress: (message: string) => void,
): Promise<SensorReading> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access is unavailable in this browser.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })
  const AudioContextClass = window.AudioContext
  const context = new AudioContextClass()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  const rmsValues: number[] = []
  const started = performance.now()
  onProgress('Measuring sound level locally for four seconds…')

  try {
    while (performance.now() - started < MEASUREMENT_MS) {
      analyser.getFloatTimeDomainData(samples)
      const meanSquare = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length
      rmsValues.push(Math.sqrt(meanSquare))
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
  } finally {
    stream.getTracks().forEach((track) => track.stop())
    source.disconnect()
    await context.close()
  }

  const rms = rmsValues.reduce((sum, value) => sum + value, 0) / Math.max(1, rmsValues.length)
  const relativeLevel = Number(Math.min(1, rms * 12).toFixed(2))
  return {
    timestamp: new Date().toISOString(),
    source: 'phone',
    sensor_type: 'sound_level',
    value: relativeLevel,
    unit: 'relative',
    confidence: 0.7,
    is_simulated: false,
    metadata: { classification: classify(relativeLevel), measurement_seconds: 4 },
  }
}
