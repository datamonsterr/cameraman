import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import type { Camera, CreateCameraRequest, UpdateCameraRequest } from '@/types/api'
import { useCreateCamera, useUpdateCamera } from './api'

/** Add (camera undefined) or edit a camera. */
export function CameraFormDialog({
  open,
  onOpenChange,
  camera,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  camera?: Camera
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && <CameraForm camera={camera} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function CameraForm({ camera, onDone }: { camera?: Camera; onDone: () => void }) {
  const create = useCreateCamera()
  const update = useUpdateCamera()
  const editing = !!camera
  const [name, setName] = useState(camera?.name ?? '')
  const [host, setHost] = useState(camera?.host ?? '')
  const [port, setPort] = useState(String(camera?.port ?? 554))
  const [path, setPath] = useState(camera?.rtsp_path ?? '/')
  const [transport, setTransport] = useState<'tcp' | 'udp'>(camera?.transport ?? 'tcp')
  const [username, setUsername] = useState(camera?.rtsp_username ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pending = create.isPending || update.isPending

  async function submit(e: FormEvent) {
    e.preventDefault()
    const portNum = Number(port)
    if (!name.trim() || !host.trim()) return setError('Name and host are required')
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return setError('Port must be 1-65535')
    setError(null)
    const body: CreateCameraRequest = {
      name: name.trim(),
      host: host.trim(),
      port: portNum,
      rtsp_path: path.trim() || '/',
      transport,
    }
    if (username.trim()) body.rtsp_username = username.trim()
    if (password) body.rtsp_password = password
    try {
      if (camera) {
        const patch: UpdateCameraRequest = body
        await update.mutateAsync({ id: camera.id, body: patch })
        toast.success(`Updated ${body.name}`)
      } else {
        await create.mutateAsync(body)
        toast.success(`Added ${body.name}`)
      }
      onDone()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Request failed'
      setError(msg)
      toast.error(msg)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <DialogHeader>
        <DialogTitle>{editing ? 'Edit camera' : 'Add camera'}</DialogTitle>
        <DialogDescription>
          {editing ? 'Update connection settings.' : 'Add a camera by RTSP address. Connect it afterwards.'}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="cam-name">Name</Label>
        <Input id="cam-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-[1fr_5rem] gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="cam-host">Host</Label>
          <Input id="cam-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.38" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cam-port">Port</Label>
          <Input id="cam-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="cam-path">RTSP path</Label>
          <Input id="cam-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/stream1" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cam-transport">Transport</Label>
          <NativeSelect id="cam-transport" value={transport} onChange={(e) => setTransport(e.target.value as 'tcp' | 'udp')}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </NativeSelect>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="cam-user">Username</Label>
          <Input id="cam-user" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cam-pass">Password</Label>
          <Input
            id="cam-pass"
            type="password"
            autoComplete="new-password"
            placeholder={editing && camera?.has_credentials ? 'unchanged' : ''}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : editing ? 'Save' : 'Add camera'}
        </Button>
      </DialogFooter>
    </form>
  )
}
