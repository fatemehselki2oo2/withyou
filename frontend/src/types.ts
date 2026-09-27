export type ActivityState = 'still' | 'walking' | 'active' | 'sleeping'
export type SensorSource = 'phone' | 'arduino' | 'watch' | 'manual'
export type SensorType =
  | 'activity'
  | 'motion'
  | 'sound_level'
  | 'temperature'
  | 'humidity'
  | 'light'
  | 'sleep'
  | 'mood'
  | 'proximity'
  | 'steps'
  | 'heart_rate'

export type SensorMetadata = Record<string, string | number | boolean | null>

export interface SensorReading {
  id?: number | string
  demo_session_id?: string | null
  device_id?: string | null
  timestamp: string
  source: SensorSource
  sensor_type: SensorType
  value: number
  unit: string
  confidence?: number
  is_simulated: boolean
  metadata: SensorMetadata
}

export interface HomeSensorSessionResponse {
  status: 'ok'
  demo_session_id: string
  device_id: string
  updated_at: string | null
  expires_at: string
  readings: SensorReading[]
}

export interface HealthConnectSummaryResponse {
  status: 'ok'
  updated_at: string | null
  summaries: SensorReading[]
}

export interface ActivityReading {
  id?: number
  timestamp: string
  source: 'phone'
  activity_level: number
  state: ActivityState
  is_simulated: boolean
}

export interface BaselineProfile {
  id: 'demo'
  normal_activity_level: number
  normal_inactivity_duration: number
  normal_sleep_duration: number
  normal_sleep_start: string
  normal_wake_time: string
  normal_daily_steps: number | null
  normal_heart_rate: number | null
  sleep_baseline_source: 'demo' | 'health_connect' | 'adaptive'
  steps_baseline_source: 'demo' | 'health_connect' | 'adaptive'
  heart_rate_baseline_source: 'demo' | 'health_connect' | 'adaptive'
  baseline_status: 'ready'
  baseline_confidence: 'high'
  is_demo_baseline: true
}

export type ComparisonStatus = 'normal' | 'changed'
export type EvidenceSource = 'phone_motion' | 'watch_steps' | 'home_sensor'
export type ActivityInterpretation = 'normal' | 'changed' | 'mixed' | 'unavailable'
export type EvidenceConfidence = 'none' | 'low' | 'normal' | 'high'
export type BaselineQualificationState = 'learning' | 'qualified' | 'adapting'
export type BaselineDataConfidence = 'low' | 'medium' | 'high'

export interface BaselineDataQualification {
  confidence: BaselineDataConfidence
  qualified_for_baseline: boolean
  supporting_sources: string[]
  conflicting_sources: string[]
  reason: string
}

export interface ActivityFusionAnalysis {
  interpretation: ActivityInterpretation
  confidence: EvidenceConfidence
  supporting_sources: EvidenceSource[]
  missing_sources: EvidenceSource[]
  note: string
}

export interface PatternAnalysis {
  status: ComparisonStatus
  severity: 'low' | 'moderate'
  reasons: string[]
  check_in_recommended: boolean
  activity_fusion: ActivityFusionAnalysis
  supporting_sources: EvidenceSource[]
  missing_sources: EvidenceSource[]
}

export interface WellnessContext {
  activity: {
    current: number
    baseline: number
    difference_percent: number
    status: ComparisonStatus
  } | null
  sleep: {
    hours: number
    baseline_hours: number
    status: ComparisonStatus
  } | null
  steps: {
    current: number
    baseline: number
    difference_percent: number
    status: ComparisonStatus
  } | null
  heart_rate: {
    current: number
    baseline: number
    difference_percent: number
    status: ComparisonStatus
  } | null
  environment: {
    temperature: number | null
    temperature_source: 'simulated' | 'arduino' | 'unknown' | null
    humidity: number | null
    light: number | null
    sound_level: 'quiet' | 'normal' | 'loud' | 'unknown'
  }
  mood: string | null
  activity_fusion: ActivityFusionAnalysis
  supporting_sources: EvidenceSource[]
  missing_sources: EvidenceSource[]
  baseline_state: BaselineQualificationState
  baseline_states: Record<string, BaselineQualificationState>
  data_confidence: Record<string, BaselineDataQualification>
  overall_pattern_status: ComparisonStatus
  severity: 'low' | 'moderate'
  reasons: string[]
  check_in_recommended: boolean
}

export interface CompanionResult {
  text: string
  observations_used: string[]
  used_ai: boolean
  transcript?: string
  audio_base64?: string | null
  audio_mime_type?: string | null
  audio_available?: boolean
}

