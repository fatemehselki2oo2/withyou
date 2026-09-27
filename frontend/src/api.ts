// `import.meta.env` is supplied by Vite in the browser. The optional access also
// lets the small frontend unit tests import API helpers directly in Node.
const viteEnv = import.meta.env as ImportMetaEnv | undefined
const configuredApiBaseUrl = viteEnv?.VITE_API_BASE_URL?.replace(/\/+$/, '')
const PRODUCTION_API_BASE_URL = 'https://withyou-1g5l.onrender.com'

export const API_BASE_URL = configuredApiBaseUrl
  || (viteEnv?.DEV ? 'http://127.0.0.1:8000' : PRODUCTION_API_BASE_URL)

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}
