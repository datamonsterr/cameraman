import { Camera as CameraIcon, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState, PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useCameras } from '@/features/cameras/api'
import { CameraCard } from '@/features/cameras/camera-card'
import { CameraFormDialog } from '@/features/cameras/camera-form-dialog'
import { ScanPanel } from '@/features/cameras/scan-panel'
import { useCanOperate } from '@/hooks/use-can-operate'

export function CamerasPage() {
  const canOperate = useCanOperate()
  const { data: cameras, isLoading, error } = useCameras()
  const [adding, setAdding] = useState(false)
  const known = useMemo(() => new Set((cameras ?? []).map((c) => `${c.host}:${c.port}`)), [cameras])

  return (
    <>
      <PageHeader
        title="Cameras"
        description="Discover, connect and manage cameras."
        actions={
          canOperate && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus />
              Add camera
            </Button>
          )
        }
      />
      {canOperate && <ScanPanel knownHosts={known} />}
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="aspect-video" />
          ))}
        </div>
      ) : error ? (
        <p role="alert" className="text-destructive text-sm">
          {error.message}
        </p>
      ) : cameras && cameras.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {cameras.map((c) => (
            <CameraCard key={c.id} camera={c} canOperate={canOperate} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<CameraIcon className="size-6" />}
          title="No cameras yet"
          description={canOperate ? 'Scan your LAN or add a camera manually to get started.' : 'No cameras have been added.'}
        />
      )}
      {canOperate && <CameraFormDialog open={adding} onOpenChange={setAdding} />}
    </>
  )
}
