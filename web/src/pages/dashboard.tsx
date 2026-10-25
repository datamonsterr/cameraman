import { LayoutDashboard } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { useCameras } from '@/features/cameras/api'
import { LiveFrame } from '@/features/cameras/live-frame'
import { LiveToggle } from '@/features/cameras/live-toggle'
import { mergeEvents } from '@/features/live/events'
import { useEventStream } from '@/features/live/use-event-stream'
import { countByStatus } from '@/features/cameras/status'
import { StatusBadge } from '@/features/cameras/status-badge'
import { useEvents } from '@/features/events/api'
import { EventList } from '@/features/events/recent-events'
import { cn } from '@/lib/utils'
import type { CameraStatus } from '@/types/api'

const LAYOUTS = [1, 4, 9, 16] as const
type Layout = (typeof LAYOUTS)[number]
const COLS: Record<Layout, string> = {
  1: 'grid-cols-1',
  4: 'grid-cols-2',
  9: 'grid-cols-3',
  16: 'grid-cols-4',
}
const STATUSES: CameraStatus[] = ['online', 'connecting', 'discovered', 'offline', 'error']

export function DashboardPage() {
  const [layout, setLayout] = useState<Layout>(4)
  const { data: cameras = [] } = useCameras()
  const { data: fetched = [] } = useEvents({}, 10, { refetchInterval: 10_000 })
  const { events: liveEvents } = useEventStream()
  const events = useMemo(() => mergeEvents(liveEvents, fetched, 10), [liveEvents, fetched])
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set())
  const toggleLive = (id: string, on: boolean) =>
    setLiveIds((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })
  const online = useMemo(() => cameras.filter((c) => c.status === 'online'), [cameras])
  const counts = useMemo(() => countByStatus(cameras), [cameras])
  const names = useMemo(() => new Map(cameras.map((c) => [c.id, c.name])), [cameras])
  const shown = online.slice(0, layout)

  return (
    <>
      <PageHeader title="Dashboard" description="Live cameras, system health and recent events." />
      <section aria-label="System health" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {STATUSES.map((s) => (
          <div key={s} className="flex items-center justify-between rounded-lg border px-3 py-2">
            <StatusBadge status={s} className="border-transparent px-0" />
            <span className="text-lg font-semibold tabular-nums" data-testid={`count-${s}`}>
              {counts[s]}
            </span>
          </div>
        ))}
      </section>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-label="Live grid">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-medium">Live</h2>
            <div className="flex gap-1" role="group" aria-label="Grid layout">
              {LAYOUTS.map((n) => (
                <Button key={n} size="xs" variant={layout === n ? 'secondary' : 'ghost'} aria-pressed={layout === n} onClick={() => setLayout(n)}>
                  {n}
                </Button>
              ))}
            </div>
          </div>
          {shown.length > 0 ? (
            <div className={cn('grid gap-2', COLS[layout])}>
              {shown.map((c) => (
                <div key={c.id} className="relative overflow-hidden rounded-lg border">
                  <Link to={`/cameras/${c.id}`} className="block">
                    <LiveFrame cameraId={c.id} alt={`${c.name} live`} live={liveIds.has(c.id)} />
                  </Link>
                  <LiveToggle live={liveIds.has(c.id)} onChange={(v) => toggleLive(c.id, v)} label={c.name} />
                  <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">{c.name}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<LayoutDashboard className="size-6" />} title="No online cameras" description="Connect a camera on the Cameras page to see it live here." />
          )}
        </section>
        <section aria-label="Recent events">
          <h2 className="mb-2 text-xs font-medium">Recent events</h2>
          {events.length > 0 ? (
            <div className="rounded-lg border px-3">
              <EventList events={events} cameraNames={names} />
            </div>
          ) : (
            <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-xs">No events yet.</p>
          )}
        </section>
      </div>
    </>
  )
}
