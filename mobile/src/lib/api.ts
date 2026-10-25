import { useAuth } from '@/stores/auth'
import type {
  ApiErrorBody,
  AuthResponse,
  Camera,
  CameraEvent,
  DeviceRegistration,
  RefreshResponse,
} from '@/types/api'
import { apiBaseUrl } from './config'

export { apiBaseUrl }

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
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.auth !== false && token) headers.Authorization = `Bearer ${token}`
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
      const res = await send(
        '/auth/refresh',
        { method: 'POST', body: { refresh_token: refreshToken }, auth: false },
        null,
      )
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

// Monitor-only: the client deliberately exposes read calls plus auth/device registration.
export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'GET' }),
  post: <T = void>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'POST', body }),
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const s = await api.post<AuthResponse>('/auth/login', { email, password }, { auth: false })
  useAuth.getState().setSession(s)
  return s
}

export async function logout(): Promise<void> {
  const { refreshToken, clear } = useAuth.getState()
  try {
    if (refreshToken) await api.post('/auth/logout', { refresh_token: refreshToken }, { auth: false })
  } catch {
    /* best effort */
  } finally {
    clear()
  }
}

export const listCameras = () => api.get<Camera[]>('/cameras')
export const getCamera = (id: string) => api.get<Camera>(`/cameras/${id}`)

export interface EventQuery {
  camera_id?: string
  limit?: number
}

export function listEvents(q: EventQuery = {}): Promise<CameraEvent[]> {
  const p = new URLSearchParams()
  if (q.camera_id) p.set('camera_id', q.camera_id)
  if (q.limit) p.set('limit', String(q.limit))
  const qs = p.toString()
  return api.get<CameraEvent[]>(`/events${qs ? `?${qs}` : ''}`)
}

/** Image source for RN <Image>: URL with cache-busting tick + bearer header. */
export function snapshotSource(cameraId: string, tick: number) {
  const token = useAuth.getState().accessToken
  return {
    uri: `${apiBaseUrl()}/cameras/${cameraId}/snapshot?t=${tick}`,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  }
}

/**
 * STUB: backend has no `POST /devices` yet (not in SPEC §7). Fails soft so the
 * app works before the endpoint exists. Returns true when the server accepted it.
 */
export async function registerDevice(d: DeviceRegistration): Promise<boolean> {
  try {
    await api.post('/devices', d)
    return true
  } catch {
    return false
  }
}
