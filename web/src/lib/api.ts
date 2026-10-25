import { useAuth } from '@/stores/auth'
import type { ApiErrorBody, RefreshResponse } from '@/types/api'

const DEFAULT_BASE = 'http://localhost:8080/api/v1'

export function apiBaseUrl(): string {
  const v = import.meta.env.VITE_API_BASE_URL as string | undefined
  return (v && v.length > 0 ? v : DEFAULT_BASE).replace(/\/+$/, '')
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export interface RequestOptions {
  method?: string
  body?: unknown
  /** Attach bearer + auto-refresh on 401. Default true; false for public endpoints. */
  auth?: boolean
  signal?: AbortSignal
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function toError(res: Response, body: unknown): ApiError {
  const b = body as ApiErrorBody | string | undefined
  const msg =
    (typeof b === 'object' && b ? (b.message ?? b.error) : undefined) ??
    (typeof b === 'string' && b ? b : undefined) ??
    res.statusText ??
    `HTTP ${res.status}`
  return new ApiError(res.status, msg || `HTTP ${res.status}`, body)
}

function send(path: string, opts: RequestOptions, token: string | null): Promise<Response> {
  const headers = new Headers()
  headers.set('Accept', 'application/json')
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json')
  if (opts.auth !== false && token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(`${apiBaseUrl()}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  })
}

let refreshing: Promise<string | null> | null = null

/** Single-flight refresh. Resolves new access token, or null (and logs out) on failure. */
function refreshTokens(): Promise<string | null> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const { refreshToken, setTokens, clear } = useAuth.getState()
    if (!refreshToken) {
      clear()
      return null
    }
    try {
      const res = await send('/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken }, auth: false }, null)
      if (!res.ok) throw toError(res, await parse(res))
      const data = (await parse(res)) as RefreshResponse
      setTokens(data, data.user)
      return data.access_token
    } catch {
      clear()
      return null
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(path, opts, useAuth.getState().accessToken)
  if (res.status === 401 && opts.auth !== false) {
    const token = await refreshTokens()
    if (!token) throw toError(res, await parse(res))
    res = await send(path, opts, token)
  }
  const body = await parse(res)
  if (!res.ok) throw toError(res, body)
  return body as T
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) => request<T>(path, { ...opts, method: 'GET' }),
  post: <T = void>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'PATCH', body }),
  delete: <T = void>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'DELETE' }),
}
