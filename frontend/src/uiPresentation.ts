import type { BaselineQualificationState, ComparisonStatus } from './types.ts'

export type SourceRailId = 'phone' | 'health' | 'home' | 'checkins'
export type SourceRailTone = 'connected' | 'attention' | 'muted'

export interface SourceRailItem {
  id: SourceRailId
  label: string
  state: string
  detail: string
  tone: SourceRailTone
}

export interface SourceRailInput {
  phoneState: 'connected' | 'permission_needed' | 'unavailable'
  phoneDetail: string
  healthState: 'connected' | 'sync_needed' | 'not_connected'
  healthDetail: string
  homeState: 'live' | 'offline' | 'not_paired' | 'connecting'
  homeDetail: string
  checkInDetail: string
}

export function buildSourceRailItems(input: SourceRailInput): SourceRailItem[] {
  const homeState = input.homeState === 'live'
    ? { state: 'Live', tone: 'connected' as const }
    : input.homeState === 'offline'
      ? { state: 'Offline', tone: 'attention' as const }
      : input.homeState === 'connecting'
        ? { state: 'Connecting', tone: 'attention' as const }
        : { state: 'Not paired', tone: 'muted' as const }

  return [
    {
      id: 'phone',
      label: 'Phone',
      state: input.phoneState === 'connected' ? 'Connected' : input.phoneState === 'unavailable' ? 'Unavailable' : 'Permission needed',
      detail: input.phoneDetail,
      tone: input.phoneState === 'connected' ? 'connected' : input.phoneState === 'permission_needed' ? 'attention' : 'muted',
    },
    {
      id: 'health',
      label: 'Health',
      state: input.healthState === 'connected' ? 'Connected · synced' : input.healthState === 'sync_needed' ? 'Sync needed' : 'Not connected',
      detail: input.healthDetail,
      tone: input.healthState === 'connected' ? 'connected' : input.healthState === 'sync_needed' ? 'attention' : 'muted',
    },
    {
      id: 'home',
      label: 'Home',
      state: homeState.state,
      detail: input.homeDetail,
      tone: homeState.tone,
    },
    {
      id: 'checkins',
      label: 'Check-ins',
      state: 'Available',
      detail: input.checkInDetail,
      tone: 'connected',
    },
  ]
}

export interface TodayPresentation {
  title: string
  description: string
  tone: 'normal' | 'changed' | 'learning' | 'empty'
}

export interface HealthPanelVisibility {
  showSummaries: boolean
  showAndroidManagement: boolean
  showPrimaryInstall: boolean
  showDesktopManagementNote: boolean
}

export function healthPanelVisibility(input: {
  healthState: 'connected' | 'sync_needed' | 'not_connected'
  isAndroid: boolean
  isDesktop: boolean
  helperMissing: boolean
}): HealthPanelVisibility {
  const mobileAndroid = input.isAndroid && !input.isDesktop
  return {
    showSummaries: input.healthState === 'connected',
    showAndroidManagement: mobileAndroid && (input.healthState === 'connected' || !input.helperMissing),
    showPrimaryInstall: mobileAndroid && input.healthState !== 'connected' && input.helperMissing,
    showDesktopManagementNote: input.isDesktop && input.healthState === 'connected',
  }
}

export function buildTodayPresentation(input: {
  hasCurrentData: boolean
  baselineState: BaselineQualificationState
  patternStatus: ComparisonStatus
  firstReason?: string
  missingSourceCount: number
}): TodayPresentation {
  if (!input.hasCurrentData) {
    return {
      title: 'Start fresh with WithYou',
      description: 'Connect the sources you choose, or add a check-in, to begin learning your routine.',
      tone: 'empty',
    }
  }
  if (input.baselineState === 'learning') {
    return {
      title: 'Learning your routine',
      description: 'WithYou is collecting qualified summaries during the initial 30-day learning period. It will not describe changes from your normal yet.',
      tone: 'learning',
    }
  }
  if (input.patternStatus === 'changed') {
    return {
      title: 'A meaningful change was noticed',
      description: input.firstReason ?? 'Available summaries differ from your current personal baseline.',
      tone: 'changed',
    }
  }
  return {
    title: 'Things look close to your usual routine',
    description: input.missingSourceCount
      ? 'Available sources look consistent with your normal. Missing sources were ignored, not treated as a change.'
      : 'The available summaries look consistent with your current personal baseline.',
    tone: 'normal',
  }
}

export function formatPersonalDelta(
  current: number | null,
  baseline: number | null,
  state: BaselineQualificationState,
  unit: string,
  precision = 0,
): string {
  if (current == null) return 'No recent reading'
  if (baseline == null || state === 'learning') return 'Baseline still learning'
  const difference = current - baseline
  const threshold = 10 ** -precision / 2
  if (Math.abs(difference) < threshold) return 'Close to personal baseline'
  return `${Math.abs(difference).toFixed(precision)}${unit ? ` ${unit}` : ''} ${difference > 0 ? 'higher' : 'lower'}`
}

export function readableSourceName(source: string): string {
  return source.replaceAll('_', ' ')
}
