import { api } from '@/lib/api'
import { useAuth } from '@/stores/auth'
import type { AuthResponse, LoginRequest, RegisterRequest } from '@/types/api'

export async function login(req: LoginRequest): Promise<void> {
  const res = await api.post<AuthResponse>('/auth/login', req, { auth: false })
  useAuth.getState().setSession(res)
}

export async function register(req: RegisterRequest): Promise<void> {
  const res = await api.post<AuthResponse>('/auth/register', req, { auth: false })
  useAuth.getState().setSession(res)
}

/** Clears local state always; server revoke is best-effort. */
export async function logout(): Promise<void> {
  const { refreshToken, clear } = useAuth.getState()
  try {
    await api.post('/auth/logout', { refresh_token: refreshToken })
  } catch {
    // ignore: local logout must succeed regardless
  } finally {
    clear()
  }
}
