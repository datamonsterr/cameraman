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
  has_credentials?: boolean
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

/** Landmark as the API returns it; `box` may arrive as [x,y,w,h] or an object. */
export type RawBox = [number, number, number, number] | NormBox

export interface RawLandmark {
  id: string
  camera_id: string
  name: string
  box: RawBox
  polygon?: unknown | null
  drift_threshold?: number
  similarity_threshold?: number
  created_at?: string
  updated_at?: string
}

/** Landmark with `box` normalized to an object (see features/landmarks/geometry). */
export interface Landmark extends Omit<RawLandmark, 'box'> {
  box: NormBox
}

export interface LandmarkInput {
  camera_id: string
  name: string
  box: [number, number, number, number]
  polygon?: unknown
  drift_threshold?: number
  similarity_threshold?: number
}

export type LandmarkPatch = Partial<Omit<LandmarkInput, 'camera_id'>>

// ---- node registry -------------------------------------------------------

export interface PortSpec {
  id: string
  type: string
  /** Server default is true. */
  required?: boolean
}

export interface JsonSchemaProp {
  type?: string
  title?: string
  description?: string
  format?: string
  default?: unknown
  minimum?: number
  maximum?: number
  items?: { type?: string; format?: string }
}

export interface ConfigSchema {
  type?: string
  required?: string[]
  properties?: Record<string, JsonSchemaProp>
}

export interface NodeDescriptor {
  inputs: PortSpec[]
  outputs: PortSpec[]
  config: ConfigSchema
}

export interface NodeType {
  id: string
  category: string
  title: string
  descriptor: NodeDescriptor
}

export interface NodeTypesResponse {
  version?: number
  node_types: NodeType[]
}

// ---- workflows -----------------------------------------------------------

export interface GraphNode {
  id: string
  type: string
  config: Record<string, unknown>
  position?: { x: number; y: number }
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
}

export interface WorkflowGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface Workflow {
  id: string
  name: string
  description: string | null
  enabled: boolean
  active_version_id: string | null
  active_version?: number | null
  /** Active version graph; present on the detail view only. */
  graph?: WorkflowGraph | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface WorkflowVersion {
  id: string
  workflow_id: string
  version: number
  graph: WorkflowGraph
  created_by: string | null
  created_at: string
}

export interface CreateWorkflowRequest {
  name: string
  description?: string
  graph: WorkflowGraph
}

export type UpdateWorkflowRequest = Partial<CreateWorkflowRequest>

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

/** One entry of a 422 `details` list from the graph validator. */
export interface GraphIssue {
  code: string
  message: string
  node_id?: string | null
}

// ---- settings ------------------------------------------------------------

export interface SmtpSettings {
  configured: boolean
  host: string | null
  port: number
  username: string | null
  has_secret: boolean
  from_addr: string | null
  use_tls: boolean
  updated_at: string | null
}

export interface SmtpUpdate {
  host: string
  port: number
  username?: string
  /** Omit to keep the stored secret; "" clears it. */
  password?: string
  from_addr: string
  use_tls: boolean
}

export interface AuditEntry {
  id: number
  actor_id: string | null
  action: string
  target: string | null
  detail: unknown | null
  created_at: string
}

// ---- live (websocket) ----------------------------------------------------

/** Compact event as published on `cameraman:events` / forwarded by /ws/events. */
export type LiveEvent = Partial<CameraEvent> & { kind: EventKind }

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

export interface Candidate {
  host: string
  port: number
  vendor?: string | null
  paths: string[]
  requires_auth: boolean
  source: string
}

export interface ScanResponse {
  cidr?: string
  candidates: Candidate[]
}

export interface CreateCameraRequest {
  name: string
  host: string
  port?: number
  rtsp_path?: string
  rtsp_username?: string
  rtsp_password?: string
  transport?: 'tcp' | 'udp'
  vendor?: string
}

export type UpdateCameraRequest = Partial<CreateCameraRequest>

export interface ConnectRequest {
  username?: string
  password?: string
}

export interface StatusHistory {
  id: number
  status: CameraStatus
  reason: string | null
  created_at: string
}

export interface Detection {
  id: number
  event_id: number | null
  camera_id: string | null
  label: string
  confidence: number
  box?: NormBox | null
  created_at?: string
}

export interface ApiErrorBody {
  error?: string
  message?: string
}
