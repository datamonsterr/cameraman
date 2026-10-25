import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api } from '@/lib/api'
import type { AuditEntry, SmtpSettings, SmtpUpdate, User } from '@/types/api'

export const settingsKeys = {
  smtp: ['settings', 'smtp'] as const,
  audit: (limit: number) => ['audit', limit] as const,
  users: ['users'] as const,
}

const MISSING = new Set([404, 405, 501])

/** Resolve `null` instead of throwing when the route is not implemented. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch (e) {
    if (e instanceof ApiError && MISSING.has(e.status)) return null
    throw e
  }
}

export const fetchSmtp = () => orNull(api.get<SmtpSettings>('/settings/smtp'))
export const putSmtp = (body: SmtpUpdate) => api.put<SmtpSettings>('/settings/smtp', body)
export const fetchAudit = (limit: number) => orNull(api.get<AuditEntry[]>(`/audit?limit=${limit}`))
export const fetchUsers = () => orNull(api.get<User[]>('/users'))

export function useSmtp() {
  return useQuery({ queryKey: settingsKeys.smtp, queryFn: fetchSmtp })
}

export function useSaveSmtp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: putSmtp,
    onSuccess: (data) => qc.setQueryData(settingsKeys.smtp, data),
  })
}

export function useAudit(limit: number) {
  return useQuery({ queryKey: settingsKeys.audit(limit), queryFn: () => fetchAudit(limit) })
}

export function useUsers() {
  return useQuery({ queryKey: settingsKeys.users, queryFn: fetchUsers })
}
