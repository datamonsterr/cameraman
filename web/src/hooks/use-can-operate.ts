import { hasRole, useAuth } from '@/stores/auth'

/** True for operator and admin; viewers are read-only. */
export function useCanOperate(): boolean {
  const role = useAuth((s) => s.user?.role)
  return hasRole(role, ['operator'])
}
