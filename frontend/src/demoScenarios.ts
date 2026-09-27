import type { BaselineProfile, SensorReading } from './types.ts'

export type DemoScenarioId = 'normal' | 'low' | 'sleep' | 'stress' | 'warm' | 'combined'

export interface DemoScenarioDefinition {
  id: DemoScenarioId
  label: string
  description: string
}

export interface AppliedDemoScenario extends DemoScenarioDefinition {
  appliedAt: string
  readings: SensorReading[]
}

export interface DemoScenarioState {
  selected: DemoScenarioId | null
  applied: AppliedDemoScenario | null
}

export const DEMO_SCENARIOS: DemoScenarioDefinition[] = [
  { id: 'normal', label: 'Normal Day', description: 'A calm day close to the demo reference values.' },
  { id: 'low', label: 'Low Activity', description: 'Phone motion is meaningfully lower than the demo reference.' },
  { id: 'sleep', label: 'Poor Sleep', description: 'The latest simulated sleep is much shorter than the demo reference.' },
  { id: 'stress', label: 'Stress Check-In', description: 'A simulated stressed check-in adds supportive context.' },
  { id: 'warm', label: 'Warm Room', description: 'The simulated room temperature is warm.' },
  { id: 'combined', label: 'Combined Different Day', description: 'Phone, watch, sleep, context, and room signals demonstrate a multi-source change.' },
]

export const EMPTY_DEMO_SCENARIO_STATE: DemoScenarioState = {
  selected: null,
  applied: null,
}

const definitionById = Object.fromEntries(
  DEMO_SCENARIOS.map((scenario) => [scenario.id, scenario]),
) as Record<DemoScenarioId, DemoScenarioDefinition>

function reading(
  timestamp: string,
  sensorType: SensorReading['sensor_type'],
  value: number,
  unit: string,
  source: SensorReading['source'],
  scenario: DemoScenarioId,
  metadata: SensorReading['metadata'] = {},
): SensorReading {
  return {
    timestamp,
    source,
    sensor_type: sensorType,
    value,
    unit,
    confidence: 1,
    is_simulated: true,
    metadata: { ...metadata, scenario, demo_only: true },
  }
}

export function createDemoScenarioReadings(id: DemoScenarioId, now = new Date()): SensorReading[] {
  const timestamp = now.toISOString()
  const evening = new Date(now)
  evening.setHours(20, 0, 0, 0)
  const activity = (value: number, state: string) => reading(
    timestamp, 'activity', value, 'relative', 'phone', id, { state },
  )
  const steps = (value: number) => reading(
    evening.toISOString(), 'steps', value, 'count', 'watch', id,
    { provider: 'demo', summary_kind: 'current' },
  )
  const sleep = (hours: number) => reading(
    timestamp, 'sleep', hours, 'hours', 'manual', id, { wake_time: timestamp },
  )
  const mood = (label: string, value: number) => reading(
    timestamp, 'mood', value, 'check_in', 'manual', id, { label },
  )
  const room = (type: 'temperature' | 'humidity' | 'light', value: number, unit: string, label: string) => reading(
    timestamp, type, value, unit, 'arduino', id, { label, value_source: 'simulated' },
  )
  const heartRate = (value: number) => reading(
    timestamp, 'heart_rate', value, 'bpm', 'watch', id,
    { provider: 'demo', summary_kind: 'current' },
  )

  const scenarios: Record<DemoScenarioId, SensorReading[]> = {
    normal: [activity(0.68, 'walking'), steps(7_200), sleep(7.6), mood('good', 0.9), room('temperature', 72, 'fahrenheit', 'normal room')],
    low: [activity(0.22, 'still')],
    sleep: [sleep(4.7)],
    stress: [mood('stressed', 0.3)],
    warm: [room('temperature', 83, 'fahrenheit', 'warm room'), room('humidity', 58, 'percent', 'warm room'), room('light', 430, 'lux', 'warm room')],
    combined: [
      activity(0.2, 'still'),
      steps(1_400),
      sleep(4.6),
      mood('stressed', 0.3),
      heartRate(96),
      room('temperature', 83, 'fahrenheit', 'warm room'),
      room('humidity', 74, 'percent', 'warm room'),
      room('light', 180, 'lux', 'warm room'),
    ],
  }
  return scenarios[id]
}

export function selectDemoScenario(state: DemoScenarioState, selected: DemoScenarioId): DemoScenarioState {
  return { ...state, selected }
}

export function applySelectedDemoScenario(
  state: DemoScenarioState,
  now = new Date(),
): DemoScenarioState {
  if (!state.selected) return state
  const definition = definitionById[state.selected]
  return {
    selected: state.selected,
    applied: {
      ...definition,
      appliedAt: now.toISOString(),
      readings: createDemoScenarioReadings(state.selected, now),
    },
  }
}

export function demoPresentationBaseline(baseline: BaselineProfile): BaselineProfile {
  return {
    ...baseline,
    normal_daily_steps: baseline.normal_daily_steps ?? 7_000,
    normal_heart_rate: baseline.normal_heart_rate ?? 72,
  }
}

export function readingsForRealLearning(readings: SensorReading[]): SensorReading[] {
  return readings.filter((reading) => reading.metadata.demo_only !== true)
}
