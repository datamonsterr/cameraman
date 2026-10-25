import { Check, Crosshair, Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Landmark, NormBox } from '@/types/api'
import { useCreateLandmark, useDeleteLandmark, useUpdateLandmark } from './api'
import { movedIds, toTuple } from './geometry'

/** Tracks boxes between polls; ids that moved (auto-calibration) stay highlighted briefly. */
export function useCalibrationFlash(landmarks: Landmark[], holdMs = 6000): Set<string> {
  const prev = useRef<Map<string, NormBox>>(new Map())
  const [flash, setFlash] = useState<Set<string>>(new Set())

  useEffect(() => {
    const moved = movedIds(prev.current, landmarks)
    prev.current = new Map(landmarks.map((l) => [l.id, l.box]))
    if (moved.length === 0) return
    const names = landmarks.filter((l) => moved.includes(l.id)).map((l) => l.name)
    toast.info(`Landmark recalibrated: ${names.join(', ')}`)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to externally polled data
    setFlash((s) => new Set([...s, ...moved]))
    const t = setTimeout(() => setFlash((s) => new Set([...s].filter((id) => !moved.includes(id)))), holdMs)
    return () => clearTimeout(t)
  }, [landmarks, holdMs])

  return flash
}

export function LandmarkPanel({
  cameraId,
  landmarks,
  canOperate,
  drawing,
  onDrawingChange,
  draft,
  onDraftDone,
  highlight,
}: {
  cameraId: string
  landmarks: Landmark[]
  canOperate: boolean
  drawing: boolean
  onDrawingChange: (d: boolean) => void
  draft: NormBox | null
  onDraftDone: () => void
  highlight: Set<string>
}) {
  const create = useCreateLandmark()
  const remove = useDeleteLandmark()
  const [name, setName] = useState('')

  async function saveDraft(e: FormEvent) {
    e.preventDefault()
    if (!draft || !name.trim()) return
    try {
      await create.mutateAsync({ camera_id: cameraId, name: name.trim(), box: toTuple(draft) })
      toast.success('Landmark saved')
      setName('')
      onDraftDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save landmark')
    }
  }

  async function del(l: Landmark) {
    try {
      await remove.mutateAsync(l.id)
      toast.success(`Deleted ${l.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete landmark')
    }
  }

  return (
    <section aria-label="Landmarks" className="rounded-lg border p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium">Landmarks</h2>
        {canOperate && (
          <Button size="xs" variant={drawing ? 'secondary' : 'outline'} aria-pressed={drawing} onClick={() => onDrawingChange(!drawing)}>
            <Crosshair />
            {drawing ? 'Cancel' : 'Draw'}
          </Button>
        )}
      </div>
      {drawing && !draft && <p className="text-muted-foreground mb-2 text-[11px]">Drag over the frame to outline the object.</p>}
      {draft && (
        <form onSubmit={saveDraft} className="mb-2 flex items-center gap-1.5" aria-label="Name new landmark">
          <Input aria-label="Landmark name" autoFocus placeholder="Name, e.g. door" className="h-7" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" size="xs" disabled={!name.trim() || create.isPending}>
            Save
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Discard drawing"
            onClick={() => {
              setName('')
              onDraftDone()
            }}
          >
            <X />
          </Button>
        </form>
      )}
      {landmarks.length === 0 ? (
        <p className="text-muted-foreground text-xs">{canOperate ? 'No landmarks yet. Use Draw to outline one.' : 'No landmarks defined.'}</p>
      ) : (
        <ul className="grid gap-1.5">
          {landmarks.map((l) => (
            <LandmarkRow key={l.id} landmark={l} canOperate={canOperate} flash={highlight.has(l.id)} onDelete={() => void del(l)} />
          ))}
        </ul>
      )}
    </section>
  )
}

function LandmarkRow({ landmark: l, canOperate, flash, onDelete }: { landmark: Landmark; canOperate: boolean; flash: boolean; onDelete: () => void }) {
  const update = useUpdateLandmark()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(l.name)
  const [drift, setDrift] = useState(l.drift_threshold != null ? String(l.drift_threshold) : '')
  const [sim, setSim] = useState(l.similarity_threshold != null ? String(l.similarity_threshold) : '')

  async function submit(e: FormEvent) {
    e.preventDefault()
    const body: { name?: string; drift_threshold?: number; similarity_threshold?: number } = {}
    if (name.trim() && name.trim() !== l.name) body.name = name.trim()
    if (drift !== '' && Number(drift) !== l.drift_threshold) body.drift_threshold = Number(drift)
    if (sim !== '' && Number(sim) !== l.similarity_threshold) body.similarity_threshold = Number(sim)
    try {
      if (Object.keys(body).length) await update.mutateAsync({ id: l.id, body })
      setEditing(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update landmark')
    }
  }

  if (editing) {
    return (
      <li className="rounded-md border p-2">
        <form onSubmit={submit} className="grid gap-1.5" aria-label={`Edit ${l.name}`}>
          <Input aria-label="Name" className="h-7" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="grid grid-cols-2 gap-1.5">
            <Input aria-label="Drift threshold" className="h-7" type="number" step="0.01" min="0" value={drift} onChange={(e) => setDrift(e.target.value)} />
            <Input aria-label="Similarity threshold" className="h-7" type="number" step="0.01" min="0" max="1" value={sim} onChange={(e) => setSim(e.target.value)} />
          </div>
          <div className="flex justify-end gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={update.isPending}>
              <Check />
              Save
            </Button>
          </div>
        </form>
      </li>
    )
  }

  return (
    <li className={cn('flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs', flash && 'border-amber-300')}>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{l.name}</p>
        <p className="text-muted-foreground font-mono text-[10px]">
          {l.box.x.toFixed(2)}, {l.box.y.toFixed(2)} · {l.box.w.toFixed(2)}×{l.box.h.toFixed(2)}
          {flash && <span className="ml-1 text-amber-300">recalibrated</span>}
        </p>
      </div>
      {canOperate && (
        <>
          <Button size="icon-xs" variant="ghost" aria-label={`Edit ${l.name}`} onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label={`Delete ${l.name}`} onClick={onDelete}>
            <Trash2 />
          </Button>
        </>
      )}
    </li>
  )
}
