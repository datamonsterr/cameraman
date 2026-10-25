import type { SmtpUpdate } from '@/types/api'

export interface SmtpFormValues {
  host: string
  port: string
  username: string
  password: string
  from_addr: string
  use_tls: boolean
  clearPassword: boolean
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Field-level errors mirroring the server (host required, port 1-65535, from is an email). */
export function validateSmtp(v: SmtpFormValues): Partial<Record<'host' | 'port' | 'from_addr', string>> {
  const e: Partial<Record<'host' | 'port' | 'from_addr', string>> = {}
  if (!v.host.trim()) e.host = 'Host is required'
  const port = Number(v.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) e.port = 'Port must be 1-65535'
  if (!EMAIL_RE.test(v.from_addr.trim())) e.from_addr = 'Enter a valid from address'
  return e
}

/** Secret semantics: omit = keep stored, "" = clear, non-empty = rotate. */
export function toSmtpUpdate(v: SmtpFormValues): SmtpUpdate {
  const body: SmtpUpdate = {
    host: v.host.trim(),
    port: Number(v.port),
    username: v.username.trim(),
    from_addr: v.from_addr.trim(),
    use_tls: v.use_tls,
  }
  if (v.clearPassword) body.password = ''
  else if (v.password) body.password = v.password
  return body
}
