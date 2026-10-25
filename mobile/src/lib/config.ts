const DEFAULT_BASE = 'http://localhost:8080/api/v1'

export function apiBaseUrl(): string {
  const v = process.env.EXPO_PUBLIC_API_BASE_URL
  return (v && v.length > 0 ? v : DEFAULT_BASE).replace(/\/+$/, '')
}
