import { apiUrl } from './api'
import type { HealthConnectSummaryResponse } from './types'

export async function fetchHealthConnectSummaries(): Promise<HealthConnectSummaryResponse> {
  const response = await fetch(apiUrl('/api/sensors/health-connect/summaries'), {
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('health_connect_summaries_unavailable')
  return response.json() as Promise<HealthConnectSummaryResponse>
}
