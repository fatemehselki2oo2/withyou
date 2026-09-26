const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, '')
const PRODUCTION_API_BASE_URL = 'https://withyou-1g5l.onrender.com'

export const API_BASE_URL = configuredApiBaseUrl
  || (import.meta.env.DEV ? 'http://127.0.0.1:8000' : PRODUCTION_API_BASE_URL)

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}
