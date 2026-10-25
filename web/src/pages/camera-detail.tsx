import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/layout/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { useCamera, useStatusHistory } from '@/features/cameras/api'
import { SnapshotImage } from '@/features/cameras/snapshot-image'
import { StatusBadge } from '@/features/cameras/status-badge'
import { formatDateTime, timeAgo } from '@/lib/time'

export function CameraDetailPage() {
  const { id } = useParams()
  const { data: cam, isLoading, error } = useCamera(id)
  const history = useStatusHistory(id)

  return (
    <>
      <Link to="/cameras" className="text-muted-foreground hover:text-foreground mb-2 inline-flex items-center gap-1 text-xs">
        <ArrowLeft className="size-3" /> Cameras
      </Link>
      {isLoading ? (
        <Skeleton className="aspect-video max-w-3xl" />
      ) : error || !cam ? (
        <p role="alert" className="text-destructive text-sm">
          {error?.message ?? 'Camera not found'}
        </p>
      ) : (
        <>
          <PageHeader title={cam.name} description={`${cam.host}:${cam.port}${cam.rtsp_path}`} actions={<StatusBadge status={cam.status} />} />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="overflow-hidden rounded-lg border">
              <SnapshotImage cameraId={cam.id} alt={`${cam.name} live`} enabled={cam.status === 'online'} intervalMs={2000} />
            </div>
            <div className="grid content-start gap-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border p-3 text-xs">
                <dt className="text-muted-foreground">Vendor</dt>
                <dd>{cam.vendor ?? '-'}</dd>
                <dt className="text-muted-foreground">Resolution</dt>
                <dd>{cam.width && cam.height ? `${cam.width}x${cam.height}` : '-'}</dd>
                <dt className="text-muted-foreground">Codec</dt>
                <dd>{cam.codec ?? '-'}</dd>
                <dt className="text-muted-foreground">Transport</dt>
                <dd className="uppercase">{cam.transport}</dd>
                <dt className="text-muted-foreground">Last seen</dt>
                <dd>{cam.last_seen_at ? timeAgo(cam.last_seen_at) : '-'}</dd>
                {cam.status_reason && (
                  <>
                    <dt className="text-muted-foreground">Reason</dt>
                    <dd className="text-destructive">{cam.status_reason}</dd>
                  </>
                )}
              </dl>
              <section aria-label="Status history" className="rounded-lg border p-3">
                <h2 className="mb-2 text-xs font-medium">Status history</h2>
                {history.isLoading ? (
                  <Skeleton className="h-16" />
                ) : history.data && history.data.length > 0 ? (
                  <ul className="grid max-h-80 gap-1.5 overflow-auto text-xs">
                    {history.data.map((h) => (
                      <li key={h.id} className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <StatusBadge status={h.status} />
                          {h.reason && <span className="text-muted-foreground truncate">{h.reason}</span>}
                        </span>
                        <time className="text-muted-foreground shrink-0" dateTime={h.created_at} title={formatDateTime(h.created_at)}>
                          {timeAgo(h.created_at)}
                        </time>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-xs">No status changes recorded.</p>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </>
  )
}
