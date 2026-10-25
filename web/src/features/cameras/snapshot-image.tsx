import { CameraOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSnapshot } from './use-snapshot'

/** Auto-refreshing camera frame (16:9). Falls back to a placeholder when unavailable. */
export function SnapshotImage({
  cameraId,
  alt,
  enabled = true,
  intervalMs = 3000,
  className,
}: {
  cameraId: string
  alt: string
  enabled?: boolean
  intervalMs?: number
  className?: string
}) {
  const { url, loading } = useSnapshot(cameraId, { enabled, intervalMs })
  return (
    <div className={cn('bg-muted/40 relative aspect-video w-full overflow-hidden', className)}>
      {url ? (
        <img src={url} alt={alt} className="size-full object-cover" />
      ) : (
        <div className="text-muted-foreground flex size-full flex-col items-center justify-center gap-1 text-[11px]">
          <CameraOff className="size-5" />
          {enabled && loading ? 'Loading…' : 'No signal'}
        </div>
      )}
    </div>
  )
}
