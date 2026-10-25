import type { Camera, CameraStatus, ConnectRequest, CreateCameraRequest } from '@/types/api'

export type ConnectState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'connecting'; cameraId: string }
  | { phase: 'online'; camera: Camera }
  /** `camera` is set once the camera has been persisted (so a retry reuses it). */
  | { phase: 'error'; reason: string; camera?: Camera }

export type ConnectEvent =
  | { type: 'start' }
  | { type: 'created'; camera: Camera }
  | { type: 'result'; camera: Camera }
  | { type: 'failed'; reason: string; camera?: Camera }
  | { type: 'reset' }

export const initialConnectState: ConnectState = { phase: 'idle' }

const FALLBACK_REASON = 'Connection failed'

/**
 * Map a camera returned by POST /cameras/:id/connect to a flow state.
 * The backend answers HTTP 200 even when the connect failed, with status="error".
 */
export function resultToState(camera: Camera): ConnectState {
  const status: CameraStatus = camera.status
  switch (status) {
    case 'online':
      return { phase: 'online', camera }
    case 'error':
    case 'offline':
      return { phase: 'error', reason: camera.status_reason || FALLBACK_REASON, camera }
    default:
      // discovered | connecting: still in flight (or unexpected) - keep waiting.
      return { phase: 'connecting', cameraId: camera.id }
  }
}

export function connectReducer(state: ConnectState, ev: ConnectEvent): ConnectState {
  switch (ev.type) {
    case 'start':
      return state.phase === 'error' && state.camera
        ? { phase: 'connecting', cameraId: state.camera.id }
        : { phase: 'creating' }
    case 'created':
      return { phase: 'connecting', cameraId: ev.camera.id }
    case 'result':
      return resultToState(ev.camera)
    case 'failed':
      return { phase: 'error', reason: ev.reason || FALLBACK_REASON, camera: ev.camera }
    case 'reset':
      return initialConnectState
  }
}

export interface ConnectDeps {
  create: (body: CreateCameraRequest) => Promise<Camera>
  connect: (id: string, body: ConnectRequest) => Promise<Camera>
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Drive create-then-connect, emitting events. Reuses `existing` (a camera saved by a
 * previous failed attempt) instead of creating a duplicate. Never throws.
 */
export async function runConnectFlow(
  deps: ConnectDeps,
  input: { create: CreateCameraRequest; credentials?: ConnectRequest; existing?: Camera },
  emit: (ev: ConnectEvent) => void,
): Promise<ConnectState> {
  let state = connectReducer(initialConnectState, { type: 'start' })
  const dispatch = (ev: ConnectEvent) => {
    state = connectReducer(state, ev)
    emit(ev)
  }
  let camera = input.existing
  if (!camera) {
    try {
      camera = await deps.create(input.create)
    } catch (e) {
      dispatch({ type: 'failed', reason: messageOf(e) })
      return state
    }
  }
  dispatch({ type: 'created', camera })
  const creds: ConnectRequest = {}
  if (input.credentials?.username) creds.username = input.credentials.username
  if (input.credentials?.password) creds.password = input.credentials.password
  try {
    dispatch({ type: 'result', camera: await deps.connect(camera.id, creds) })
  } catch (e) {
    dispatch({ type: 'failed', reason: messageOf(e), camera })
  }
  return state
}
