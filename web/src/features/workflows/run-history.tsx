import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { RunStatus } from '@/types/api'
import { useWorkflowRuns } from './api'

const TONE: Record<RunStatus, string> = {
  starting: 'text-amber-300',
  running: 'text-emerald-400',
  stopped: 'text-zinc-400',
  error: 'text-red-400',
}

export function RunHistory({ workflowId }: { workflowId: string | undefined }) {
  const { data, isLoading, error } = useWorkflowRuns(workflowId)
  if (!workflowId) return <p className="text-muted-foreground text-xs">Save the workflow to see runs.</p>
  if (isLoading) return <Skeleton className="h-16" />
  if (error) return <p role="alert" className="text-destructive text-xs">{error.message}</p>
  if (!data || data.length === 0) return <p className="text-muted-foreground text-xs">No runs yet. Enable the workflow to start one.</p>
  return (
    <ul className="grid gap-2 text-xs">
      {data.map((r) => (
        <li key={r.id} className="rounded-md border p-2">
          <div className="flex items-center justify-between gap-2">
            <Badge variant="outline" className={cn('capitalize', TONE[r.status])}>
              {r.status}
            </Badge>
            <time className="text-muted-foreground" dateTime={r.started_at} title={formatDateTime(r.started_at)}>
              {timeAgo(r.started_at)}
            </time>
          </div>
          {r.error && <p className="text-destructive mt-1 break-words">{r.error}</p>}
          {r.stopped_at && <p className="text-muted-foreground mt-1">Stopped {timeAgo(r.stopped_at)}</p>}
        </li>
      ))}
    </ul>
  )
}
