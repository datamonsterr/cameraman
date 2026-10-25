import { CameraOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCameraStream } from '@/features/live/use-camera-stream'
import { cn } from '@/lib/utils'
import { useSnapshot } from './use-snapshot'

/**
 * Camera frame: live WebSocket JPEG stream when `live`, otherwise (or until the first
 * stream frame / while the socket is down) snapshot polling. `aspect` makes the box match
 * the camera's real ratio so overlays (landmarks) line up with `object-fill`.
 */
export function LiveFrame({
  cameraId,
  alt,
  live = false,
  enabled = true,
  intervalMs = 3000,
  aspect,
  className,
  children,
}: {
  cameraId: string
  alt: string
  live?: boolean
  enabled?: boolean
  intervalMs?: number
  aspect?: number
  className?: string
  /** Rendered over the frame (overlays, badges). */
  children?: ReactNode
}) {
  const stream = useCameraStream(cameraId, { enabled: enabled && live })
  const snap = useSnapshot(cameraId, { enabled: enabled && !stream.url, intervalMs })
  const src = stream.url ?? snap.url
  const streaming = !!stream.url

  return (
    <div
      className={cn('bg-muted/40 relative w-full overflow-hidden', !aspect && 'aspect-video', className)}
      style={aspect ? { aspectRatio: String(aspect) } : undefined}
      data-live={streaming ? 'true' : 'false'}
    >
      {src ? (
        <img src={src} alt={alt} className={cn('size-full', aspect ? 'object-fill' : 'object-cover')} />
      ) : (
        <div className="text-muted-foreground flex size-full flex-col items-center justify-center gap-1 text-[11px]">
          <CameraOff className="size-5" />
          {enabled && snap.loading ? 'Loading…' : 'No signal'}
        </div>
      )}
      {live && (
        <span
          className={cn(
            'absolute top-1 left-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-white',
            streaming ? 'bg-red-600/90' : 'bg-black/60',
          )}
        >
          {streaming ? 'LIVE' : stream.status === 'closed' ? 'snapshot' : 'connecting…'}
        </span>
      )}
      {children}
    </div>
  )
}
