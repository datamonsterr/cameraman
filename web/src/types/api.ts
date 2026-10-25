/** Typed entities mirroring SPEC §7 / backend/migrations/0001_init.sql. Extend as features land. */

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

export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest extends LoginRequest {
  display_name: string
}

export type CameraStatus = 'discovered' | 'connecting' | 'online' | 'offline' | 'error'

export interface Camera {
  id: string
  name: string
  vendor: string | null
  host: string
  port: number
  rtsp_path: string
  rtsp_username: string | null
  transport: 'tcp' | 'udp'
  status: CameraStatus
  status_reason: string | null
  last_seen_at: string | null
  width: number | null
  height: number | null
  codec: string | null
  created_at: string
  updated_at: string
}

export interface NormBox {
  x: number
  y: number
  w: number
  h: number
}

export interface Landmark {
  id: string
  camera_id: string
  name: string
  box: NormBox
  polygon: unknown | null
  drift_threshold: number
  similarity_threshold: number
  created_at: string
  updated_at: string
}

export interface WorkflowGraph {
  nodes: unknown[]
  edges: unknown[]
}

export interface Workflow {
  id: string
  name: string
  description: string | null
  enabled: boolean
  active_version_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type RunStatus = 'starting' | 'running' | 'stopped' | 'error'

export interface WorkflowRun {
  id: string
  workflow_id: string
  version_id: string
  status: RunStatus
  error: string | null
  started_at: string
  stopped_at: string | null
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
