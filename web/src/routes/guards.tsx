import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { hasRole, useAuth } from '@/stores/auth'
import type { Role } from '@/types/api'

export function RequireAuth() {
  const authed = useAuth((s) => s.accessToken !== null)
  const location = useLocation()
  if (!authed) return <Navigate to="/login" replace state={{ from: location }} />
  return <Outlet />
}

export function RequireRole({ roles }: { roles: Role[] }) {
  const role = useAuth((s) => s.user?.role)
  if (!hasRole(role, roles)) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <p className="text-base font-medium">Not authorized</p>
          <p className="text-muted-foreground mt-1 text-sm">
            This area requires the {roles.join(' / ')} role.
          </p>
        </div>
      </div>
    )
  }
  return <Outlet />
}
