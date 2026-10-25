import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { CameraStatus } from '@/types/api'

const STYLE: Record<CameraStatus, { dot: string; text: string }> = {
  online: { dot: 'bg-emerald-500', text: 'text-emerald-400' },
  connecting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300' },
  discovered: { dot: 'bg-sky-400', text: 'text-sky-300' },
  offline: { dot: 'bg-zinc-500', text: 'text-zinc-400' },
  error: { dot: 'bg-red-500', text: 'text-red-400' },
}

export function StatusBadge({ status, className }: { status: CameraStatus; className?: string }) {
  const s = STYLE[status]
  return (
    <Badge variant="outline" className={cn('gap-1.5 capitalize', s.text, className)} data-status={status}>
      <span className={cn('size-1.5 rounded-full', s.dot)} />
      {status}
    </Badge>
  )
}
