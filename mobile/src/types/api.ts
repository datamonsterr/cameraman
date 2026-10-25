export type Role = 'admin' | 'operator' | 'viewer'

export interface User {
  id: string
  email: string
  display_name: string
  role: Role
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface TokenPair {
  access_token: string
  refresh_token: string
}

export interface AuthResponse extends TokenPair {
  user: User
}

/** /auth/refresh may rotate the refresh token; user is optional. */
export interface RefreshResponse extends TokenPair {
  user?: User
}

export type CameraStatus = 'discovered' | 'connecting' | 'online' | 'offline' | 'error'

export interface Camera {
  id: string
  name: string
  vendor: string | null
  host: string
  port: number
  status: CameraStatus
  status_reason: string | null
  last_seen_at: string | null
  width: number | null
  height: number | null
  codec: string | null
  created_at: string
  updated_at: string
}

export type EventKind = 'detection' | 'notification' | 'health' | 'calibration' | 'clip' | 'system'
export type EventSeverity = 'info' | 'warn' | 'alert'

export interface CameraEvent {
  id: number
  kind: EventKind
  camera_id: string | null
  workflow_id: string | null
  run_id: string | null
  severity: EventSeverity
  message: string | null
  payload: unknown | null
  snapshot_id: string | null
  created_at: string
}

export interface ApiErrorBody {
  error?: string
  message?: string
}

/** Body for the (backend-pending) device registration endpoint. */
export interface DeviceRegistration {
  token: string
  platform: 'ios' | 'android'
}
