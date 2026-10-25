import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import type { SmtpSettings } from '@/types/api'
import { useSaveSmtp, useSmtp } from './api'
import { toSmtpUpdate, validateSmtp, type SmtpFormValues } from './smtp'

export function SmtpSection() {
  const { data, isLoading, error } = useSmtp()
  if (isLoading) return <Skeleton className="h-64 max-w-lg" />
  if (error) return <p role="alert" className="text-destructive text-sm">{error.message}</p>
  if (data === null) {
    return <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-xs">SMTP settings are not available on this server yet.</p>
  }
  return <SmtpForm key={data?.updated_at ?? 'new'} settings={data} />
}

export function SmtpForm({ settings }: { settings: SmtpSettings | undefined }) {
  const save = useSaveSmtp()
  const [v, setV] = useState<SmtpFormValues>({
    host: settings?.host ?? '',
    port: String(settings?.port ?? 587),
    username: settings?.username ?? '',
    password: '',
    from_addr: settings?.from_addr ?? '',
    use_tls: settings?.use_tls ?? true,
    clearPassword: false,
  })
  const [touched, setTouched] = useState(false)
  const errors = touched ? validateSmtp(v) : {}
  const patch = (p: Partial<SmtpFormValues>) => setV((s) => ({ ...s, ...p }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (Object.keys(validateSmtp(v)).length > 0) return
    try {
      await save.mutateAsync(toSmtpUpdate(v))
      patch({ password: '', clearPassword: false })
      toast.success('SMTP settings saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save SMTP settings')
    }
  }

  return (
    <form onSubmit={submit} className="grid max-w-lg gap-3" noValidate aria-label="SMTP settings">
      <p className="text-muted-foreground text-xs">
        {settings?.configured ? 'Used by Email nodes to send notifications.' : 'Not configured yet. Email nodes cannot send until this is set.'}
      </p>
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field label="Host" id="smtp-host" error={errors.host}>
          <Input id="smtp-host" value={v.host} onChange={(e) => patch({ host: e.target.value })} aria-invalid={!!errors.host} />
        </Field>
        <Field label="Port" id="smtp-port" error={errors.port}>
          <Input id="smtp-port" inputMode="numeric" value={v.port} onChange={(e) => patch({ port: e.target.value })} aria-invalid={!!errors.port} />
        </Field>
      </div>
      <Field label="Username" id="smtp-user">
        <Input id="smtp-user" autoComplete="off" value={v.username} onChange={(e) => patch({ username: e.target.value })} />
      </Field>
      <Field label="Password" id="smtp-pass">
        <Input
          id="smtp-pass"
          type="password"
          autoComplete="new-password"
          value={v.password}
          disabled={v.clearPassword}
          placeholder={settings?.has_secret ? '•••••••• (stored, leave blank to keep)' : ''}
          onChange={(e) => patch({ password: e.target.value })}
        />
        {settings?.has_secret && (
          <label className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[11px]">
            <input type="checkbox" checked={v.clearPassword} onChange={(e) => patch({ clearPassword: e.target.checked, password: '' })} />
            Remove stored password
          </label>
        )}
      </Field>
      <Field label="From address" id="smtp-from" error={errors.from_addr}>
        <Input id="smtp-from" type="email" value={v.from_addr} onChange={(e) => patch({ from_addr: e.target.value })} aria-invalid={!!errors.from_addr} />
      </Field>
      <label className="flex items-center gap-2 text-xs">
        <Switch aria-label="Use TLS" checked={v.use_tls} onCheckedChange={(c) => patch({ use_tls: c })} />
        Use TLS
      </label>
      <div>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save SMTP settings'}
        </Button>
      </div>
    </form>
  )
}

function Field({ label, id, error, children }: { label: string; id: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {error && (
        <p role="alert" className="text-destructive text-[11px]">
          {error}
        </p>
      )}
    </div>
  )
}
