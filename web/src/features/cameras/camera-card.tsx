import { Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Camera } from '@/types/api'
import { useDeleteCamera } from './api'
import { CameraFormDialog } from './camera-form-dialog'
import { SnapshotImage } from './snapshot-image'
import { StatusBadge } from './status-badge'

export function CameraCard({ camera, canOperate }: { camera: Camera; canOperate: boolean }) {
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const del = useDeleteCamera()

  async function confirmDelete() {
    try {
      await del.mutateAsync(camera.id)
      toast.success(`Deleted ${camera.name}`)
      setDeleting(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <Card className="gap-0 overflow-hidden py-0" data-testid="camera-card">
      <Link to={`/cameras/${camera.id}`} aria-label={`Open ${camera.name}`}>
        <SnapshotImage cameraId={camera.id} alt={`${camera.name} snapshot`} enabled={camera.status === 'online'} />
      </Link>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <Link to={`/cameras/${camera.id}`} className="block truncate text-sm font-medium hover:underline">
            {camera.name}
          </Link>
          <p className="text-muted-foreground truncate font-mono text-[11px]">
            {camera.host}:{camera.port}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <StatusBadge status={camera.status} />
          {canOperate && (
            <>
              <Button size="icon-xs" variant="ghost" aria-label={`Edit ${camera.name}`} onClick={() => setEditing(true)}>
                <Pencil />
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label={`Delete ${camera.name}`} onClick={() => setDeleting(true)}>
                <Trash2 />
              </Button>
            </>
          )}
        </div>
      </div>
      {camera.status === 'error' && camera.status_reason && (
        <p className="text-destructive truncate px-3 pb-2 text-[11px]" title={camera.status_reason}>
          {camera.status_reason}
        </p>
      )}
      {canOperate && (
        <>
          <CameraFormDialog open={editing} onOpenChange={setEditing} camera={camera} />
          <Dialog open={deleting} onOpenChange={setDeleting}>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>Delete {camera.name}?</DialogTitle>
                <DialogDescription>This removes the camera and its history. It cannot be undone.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDeleting(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmDelete} disabled={del.isPending}>
                  Delete
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </Card>
  )
}
