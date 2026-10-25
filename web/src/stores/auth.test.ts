import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hasRole, useAuth } from './auth'
import { login, logout, register } from '@/features/auth/actions'
import type { AuthResponse } from '@/types/api'

const session: AuthResponse = {
  access_token: 'a1',
  refresh_token: 'r1',
  user: {
    id: 'u1', email: 'x@y.z', display_name: 'X', role: 'operator', is_active: true,
    created_at: '', updated_at: '',
  },
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  localStorage.clear()
  useAuth.getState().clear()
  vi.stubGlobal('fetch', vi.fn())
})

describe('auth store', () => {
  it('starts unauthenticated', () => {
    expect(useAuth.getState().isAuthenticated()).toBe(false)
  })

  it('setSession stores tokens + user and persists to localStorage', () => {
    useAuth.getState().setSession(session)
    const s = useAuth.getState()
    expect(s.isAuthenticated()).toBe(true)
    expect(s.user?.role).toBe('operator')
    const raw = JSON.parse(localStorage.getItem('cameraman-auth')!)
    expect(raw.state.accessToken).toBe('a1')
    expect(raw.state.refreshToken).toBe('r1')
    expect(raw.state.user.email).toBe('x@y.z')
  })

  it('clear wipes state and storage', () => {
    useAuth.getState().setSession(session)
    useAuth.getState().clear()
    expect(useAuth.getState().user).toBeNull()
    const raw = JSON.parse(localStorage.getItem('cameraman-auth')!)
    expect(raw.state.accessToken).toBeNull()
  })

  it('hasRole honours hierarchy admin > operator > viewer', () => {
    expect(hasRole('admin', ['operator'])).toBe(true)
    expect(hasRole('operator', ['operator'])).toBe(true)
    expect(hasRole('viewer', ['operator'])).toBe(false)
    expect(hasRole('operator', ['admin'])).toBe(false)
    expect(hasRole(undefined, ['viewer'])).toBe(false)
  })
})

describe('auth actions', () => {
  it('login posts credentials and stores the session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, session))
    await login({ email: 'x@y.z', password: 'pw' })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toMatch(/\/auth\/login$/)
    expect(JSON.parse(init!.body as string)).toEqual({ email: 'x@y.z', password: 'pw' })
    expect(useAuth.getState().accessToken).toBe('a1')
  })

  it('register posts and stores the session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(201, session))
    await register({ email: 'x@y.z', password: 'pw', display_name: 'X' })
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toMatch(/\/auth\/register$/)
    expect(useAuth.getState().user?.id).toBe('u1')
  })

  it('logout calls /auth/logout with refresh token and clears state', async () => {
    useAuth.getState().setSession(session)
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await logout()
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toMatch(/\/auth\/logout$/)
    expect(JSON.parse(init!.body as string)).toEqual({ refresh_token: 'r1' })
    expect(useAuth.getState().isAuthenticated()).toBe(false)
  })

  it('logout clears state even if the server call fails', async () => {
    useAuth.getState().setSession(session)
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network'))
    await logout()
    expect(useAuth.getState().isAuthenticated()).toBe(false)
  })
})
