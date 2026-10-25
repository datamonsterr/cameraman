import { timeAgo } from '@/lib/time'
import type { CameraEvent } from '@/types/api'
import { EventThumb, SeverityBadge } from './event-parts'

export function EventList({ events, cameraNames }: { events: CameraEvent[]; cameraNames: Map<string, string> }) {
  return (
    <ul className="divide-y">
      {events.map((e) => (
        <li key={e.id} className="flex items-center gap-3 py-2">
          <EventThumb snapshotId={e.snapshot_id} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs">{e.message ?? e.kind}</p>
            <p className="text-muted-foreground truncate text-[11px]">
              {e.kind}
              {e.camera_id && ` · ${cameraNames.get(e.camera_id) ?? 'unknown camera'}`}
            </p>
          </div>
          <SeverityBadge severity={e.severity} />
          <time className="text-muted-foreground w-14 shrink-0 text-right text-[11px]" dateTime={e.created_at}>
            {timeAgo(e.created_at)}
          </time>
        </li>
      ))}
    </ul>
  )
}
