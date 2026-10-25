import { ListChecks } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState, PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useCameras } from '@/features/cameras/api'
import { useEvents, type EventFilters, type TimeRange } from '@/features/events/api'
import { EventList } from '@/features/events/recent-events'
import { matchesFilter, mergeEvents } from '@/features/live/events'
import { useEventStream } from '@/features/live/use-event-stream'

const PAGE = 50
const KINDS = ['detection', 'notification', 'health', 'calibration', 'clip', 'system'] as const
const SEVERITIES = ['info', 'warn', 'alert'] as const
const RANGES: { value: TimeRange; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 days' },
]

export function EventsPage() {
  const [filters, setFilters] = useState<EventFilters>({ range: '24h' })
  const [limit, setLimit] = useState(PAGE)
  const { data: cameras } = useCameras()
  const { data: fetched, isLoading, isFetching, error } = useEvents(filters, limit, { refetchInterval: 10_000 })
  const { events: liveEvents, status: liveStatus } = useEventStream()
  const events = useMemo(
    () => (fetched ? mergeEvents(liveEvents.filter((e) => matchesFilter(e, filters)), fetched, Math.max(limit, fetched.length)) : fetched),
    [liveEvents, fetched, filters, limit],
  )
  const names = useMemo(() => new Map((cameras ?? []).map((c) => [c.id, c.name])), [cameras])

  function set(patch: Partial<EventFilters>) {
    setFilters((f) => ({ ...f, ...patch }))
    setLimit(PAGE)
  }

  return (
    <>
      <PageHeader
        title="Events"
        description="Timeline of detections, notifications and health."
        actions={
          <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]" title={`Live feed ${liveStatus}`}>
            <span className={`size-1.5 rounded-full ${liveStatus === 'open' ? 'bg-emerald-500' : 'bg-zinc-500'}`} />
            {liveStatus === 'open' ? 'Live' : 'Polling'}
          </span>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <NativeSelect aria-label="Kind" value={filters.kind ?? ''} onChange={(e) => set({ kind: e.target.value as EventFilters['kind'] })}>
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Severity" value={filters.severity ?? ''} onChange={(e) => set({ severity: e.target.value as EventFilters['severity'] })}>
          <option value="">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Camera" value={filters.camera_id ?? ''} onChange={(e) => set({ camera_id: e.target.value })}>
          <option value="">All cameras</option>
          {(cameras ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Time range" value={filters.range ?? 'all'} onChange={(e) => set({ range: e.target.value as TimeRange })}>
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {isLoading ? (
        <Skeleton className="h-48" />
      ) : error ? (
        <p role="alert" className="text-destructive text-sm">
          {error.message}
        </p>
      ) : events && events.length > 0 ? (
        <>
          <div className="rounded-lg border px-3">
            <EventList events={events} cameraNames={names} />
          </div>
          {(fetched?.length ?? 0) >= limit && (
            <div className="mt-3 flex justify-center">
              <Button size="sm" variant="outline" disabled={isFetching} onClick={() => setLimit((l) => l + PAGE)}>
                Load more
              </Button>
            </div>
          )}
        </>
      ) : (
        <EmptyState icon={<ListChecks className="size-6" />} title="No events" description="Nothing matches these filters yet." />
      )}
    </>
  )
}
