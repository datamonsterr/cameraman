import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useReducer, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Candidate } from '@/types/api'
import { candidateToCreate, useConnectCamera, useCreateCamera } from './api'
import { connectReducer, initialConnectState, runConnectFlow } from './connect-flow'

export function ConnectDialog({
  candidate,
  onOpenChange,
}: {
  candidate: Candidate | null
  onOpenChange: (o: boolean) => void
}) {
  return (
    <Dialog open={!!candidate} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {candidate && <ConnectBody key={`${candidate.host}:${candidate.port}`} candidate={candidate} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function ConnectBody({ candidate, onClose }: { candidate: Candidate; onClose: () => void }) {
  const create = useCreateCamera()
  const connect = useConnectCamera()
  const [state, dispatch] = useReducer(connectReducer, initialConnectState)
  const [name, setName] = useState(`${candidate.vendor ?? 'Camera'} ${candidate.host}`)
  const [path, setPath] = useState(candidate.paths[0] ?? '/')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const busy = state.phase === 'creating' || state.phase === 'connecting'

  async function submit(e: FormEvent) {
    e.preventDefault()
    const existing = state.phase === 'error' ? state.camera : undefined
    const final = await runConnectFlow(
      {
        create: (b) => create.mutateAsync(b),
        connect: (id, body) => connect.mutateAsync({ id, body }),
      },
      { create: candidateToCreate(candidate, { name, rtsp_path: path }), credentials: { username, password }, existing },
      dispatch,
    )
    if (final.phase === 'online') toast.success(`${final.camera.name} is online`)
    else if (final.phase === 'error') toast.error(final.reason)
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <DialogHeader>
        <DialogTitle>Connect {candidate.host}:{candidate.port}</DialogTitle>
        <DialogDescription>
          {candidate.requires_auth ? 'This camera requires credentials.' : 'Credentials are optional.'}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="cn-name">Name</Label>
        <Input id="cn-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy || state.phase === 'online'} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="cn-path">RTSP path</Label>
        <Input id="cn-path" value={path} onChange={(e) => setPath(e.target.value)} list="cn-paths" disabled={busy || !!(state.phase === 'error' && state.camera) || state.phase === 'online'} />
        <datalist id="cn-paths">
          {candidate.paths.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="cn-user">Username</Label>
          <Input id="cn-user" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cn-pass">Password</Label>
          <Input id="cn-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        </div>
      </div>
      <ConnectStatus state={state} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {state.phase === 'online' ? 'Done' : 'Close'}
        </Button>
        {state.phase !== 'online' && (
          <Button type="submit" disabled={busy}>
            {busy ? 'Connecting…' : state.phase === 'error' ? 'Retry' : 'Connect'}
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}

function ConnectStatus({ state }: { state: ReturnType<typeof connectReducer> }) {
  if (state.phase === 'idle') return null
  if (state.phase === 'creating' || state.phase === 'connecting') {
    return (
      <p role="status" className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2 className="size-3.5 animate-spin" />
        {state.phase === 'creating' ? 'Saving camera…' : 'Connecting…'}
      </p>
    )
  }
  if (state.phase === 'online') {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-emerald-400">
        <CheckCircle2 className="size-3.5" />
        Online
      </p>
    )
  }
  return (
    <p role="alert" className="text-destructive flex items-start gap-2 text-xs">
      <XCircle className="mt-0.5 size-3.5 shrink-0" />
      {state.reason}
    </p>
  )
}
