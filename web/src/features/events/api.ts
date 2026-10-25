import { useQuery } from '@tanstack/react-query'
import { ApiError, api } from '@/lib/api'
import type { CameraEvent, EventKind, EventSeverity } from '@/types/api'

export type TimeRange = 'all' | '1h' | '24h' | '7d'

export interface EventFilters {
  kind?: EventKind | ''
  severity?: EventSeverity | ''
  camera_id?: string
  range?: TimeRange
}

export const RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
}

/** Filters -> query string (no leading "?"). Empty filters are omitted. */
export function buildEventQuery(f: EventFilters = {}, limit = 50, now: number = Date.now()): string {
  const p = new URLSearchParams()
  if (f.kind) p.set('kind', f.kind)
  if (f.severity) p.set('severity', f.severity)
  if (f.camera_id) p.set('camera_id', f.camera_id)
  if (f.range && f.range !== 'all') p.set('since', new Date(now - RANGE_MS[f.range]).toISOString())
  p.set('limit', String(limit))
  return p.toString()
}

/** Newest first. Missing endpoint (404) degrades to an empty list. */
export async function fetchEvents(f: EventFilters = {}, limit = 50): Promise<CameraEvent[]> {
  try {
    const res = await api.get<CameraEvent[] | { events: CameraEvent[] }>(`/events?${buildEventQuery(f, limit)}`)
    const list = Array.isArray(res) ? res : (res?.events ?? [])
    return [...list].sort((a, b) => b.created_at.localeCompare(a.created_at))
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return []
    throw e
  }
}

export const eventKeys = {
  all: ['events'] as const,
  list: (f: EventFilters, limit: number) => [...eventKeys.all, 'list', f, limit] as const,
}

export function useEvents(f: EventFilters = {}, limit = 50, opts: { refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: eventKeys.list(f, limit),
    queryFn: () => fetchEvents(f, limit),
    refetchInterval: opts.refetchInterval,
    placeholderData: (prev) => prev,
  })
}

/** Snapshot image for an event. Contract assumption: GET /snapshots/:id returns JPEG bytes. */
export const eventSnapshotPath = (snapshotId: string) => `/snapshots/${snapshotId}`
