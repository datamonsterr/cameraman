import type { CameraEvent, EventKind, EventSeverity } from '@/types/api'

const KINDS: EventKind[] = ['detection', 'notification', 'health', 'calibration', 'clip', 'system']
const SEVERITIES: EventSeverity[] = ['info', 'warn', 'alert']

let synthetic = 0

/**
 * Parse one text frame from /ws/events. Accepts a bare event or `{event: {...}}` /
 * `{type, data: {...}}` envelopes. Returns null for anything that is not an event.
 */
export function parseLiveEvent(raw: unknown, now: () => string = () => new Date().toISOString()): CameraEvent | null {
  if (typeof raw !== 'string') return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const inner = (typeof o.event === 'object' && o.event ? o.event : typeof o.data === 'object' && o.data ? o.data : o) as Record<string, unknown>
  const kind = inner.kind
  if (typeof kind !== 'string' || !KINDS.includes(kind as EventKind)) return null
  const severity = SEVERITIES.includes(inner.severity as EventSeverity) ? (inner.severity as EventSeverity) : 'info'
  return {
    id: typeof inner.id === 'number' ? inner.id : --synthetic,
    kind: kind as EventKind,
    camera_id: typeof inner.camera_id === 'string' ? inner.camera_id : null,
    workflow_id: typeof inner.workflow_id === 'string' ? inner.workflow_id : null,
    run_id: typeof inner.run_id === 'string' ? inner.run_id : null,
    severity,
    message: typeof inner.message === 'string' ? inner.message : null,
    payload: inner.payload ?? null,
    snapshot_id: typeof inner.snapshot_id === 'string' ? inner.snapshot_id : null,
    created_at: typeof inner.created_at === 'string' ? inner.created_at : now(),
  }
}

export interface LiveFilter {
  kind?: EventKind | ''
  severity?: EventSeverity | ''
  camera_id?: string
}

export function matchesFilter(e: CameraEvent, f: LiveFilter): boolean {
  if (f.kind && e.kind !== f.kind) return false
  if (f.severity && e.severity !== f.severity) return false
  if (f.camera_id && e.camera_id !== f.camera_id) return false
  return true
}

/** Live events first, de-duplicated by id against fetched history, newest first, capped. */
export function mergeEvents(live: CameraEvent[], fetched: CameraEvent[], limit: number): CameraEvent[] {
  const seen = new Set<number>()
  const out: CameraEvent[] = []
  for (const e of [...live, ...fetched]) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit)
}

/** Prepend (most recent first), ignoring ids already present, capped at `max`. */
export function pushEvent(list: CameraEvent[], e: CameraEvent, max = 100): CameraEvent[] {
  if (list.some((x) => x.id === e.id)) return list
  return [e, ...list].slice(0, max)
}
