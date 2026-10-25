import { ImageOff } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { EventSeverity } from '@/types/api'
import { eventSnapshotPath } from './api'

const SEV: Record<EventSeverity, string> = {
  info: 'text-sky-300',
  warn: 'text-amber-300',
  alert: 'text-red-400',
}

export function SeverityBadge({ severity }: { severity: EventSeverity }) {
  return (
    <Badge variant="outline" className={cn('capitalize', SEV[severity])}>
      {severity}
    </Badge>
  )
}

/** Thumbnail for an event snapshot; fetched once with auth and shown via object URL. */
export function EventThumb({ snapshotId, className }: { snapshotId: string | null; className?: string }) {
  const q = useQuery({
    queryKey: ['snapshot', snapshotId],
    // Object URL is cached with the query (immutable snapshot), so it is intentionally not revoked.
    queryFn: async () => URL.createObjectURL(await api.blob(eventSnapshotPath(snapshotId as string))),
    enabled: !!snapshotId,
    staleTime: Infinity,
    retry: false,
  })
  const url = q.data ?? null

  if (!snapshotId) return null
  return (
    <div className={cn('bg-muted/40 aspect-video w-24 shrink-0 overflow-hidden rounded', className)}>
      {url ? (
        <img src={url} alt="Event snapshot" className="size-full object-cover" />
      ) : (
        <div className="text-muted-foreground flex size-full items-center justify-center">
          <ImageOff className="size-4" />
        </div>
      )}
    </div>
  )
}
