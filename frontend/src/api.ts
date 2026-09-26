const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, '')

export const API_BASE_URL = configuredApiBaseUrl || (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')

export function apiUrl(path: string): string {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL must be configured for production builds.')
  }

  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}
