import { ApiError, listEvents, login, logout, request, snapshotSource } from '@/lib/api'
import { useAuth } from '@/stores/auth'
import type { User } from '@/types/api'

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
)
jest.mock('expo-secure-store', () => ({
  isAvailableAsync: async () => true,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}))

const user: User = {
  id: 'u1',
  email: 'v@x.io',
  display_name: 'V',
  role: 'viewer',
  is_active: true,
  created_at: '',
  updated_at: '',
}
const BASE = 'http://localhost:8080/api/v1'

function res(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body)
  return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => text } as Response
}

const fetchMock = jest.fn()
beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as unknown as typeof fetch
  useAuth.getState().setSession({ access_token: 'a1', refresh_token: 'r1', user })
})

const authHeader = (call: number) => (fetchMock.mock.calls[call][1].headers as Record<string, string>).Authorization

describe('api client', () => {
  it('sends bearer token and parses JSON (happy path)', async () => {
    fetchMock.mockResolvedValueOnce(res(200, [{ id: 'c1' }]))
    const out = await request<{ id: string }[]>('/cameras')
    expect(out).toEqual([{ id: 'c1' }])
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/cameras`)
    expect(authHeader(0)).toBe('Bearer a1')
  })

  it('on 401 refreshes then retries with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(res(401, { error: 'expired' }))
      .mockResolvedValueOnce(res(200, { access_token: 'a2', refresh_token: 'r2' }))
      .mockResolvedValueOnce(res(200, { ok: true }))
    const out = await request('/cameras')
    expect(out).toEqual({ ok: true })
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/auth/refresh`)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ refresh_token: 'r1' })
    expect(authHeader(2)).toBe('Bearer a2')
    expect(useAuth.getState().refreshToken).toBe('r2')
  })

  it('single-flights concurrent refreshes', async () => {
    fetchMock.mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
      if (url.endsWith('/auth/refresh')) return res(200, { access_token: 'a2', refresh_token: 'r2' })
      return init.headers.Authorization === 'Bearer a1' ? res(401) : res(200, {})
    })
    await Promise.all([request('/cameras'), request('/events')])
    const refreshes = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/refresh'))
    expect(refreshes).toHaveLength(1)
  })

  it('logs out and throws when refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(res(401, { error: 'expired' }))
      .mockResolvedValueOnce(res(401, { error: 'bad refresh' }))
    await expect(request('/cameras')).rejects.toBeInstanceOf(ApiError)
    expect(useAuth.getState().isAuthenticated()).toBe(false)
    expect(useAuth.getState().refreshToken).toBeNull()
  })

  it('throws ApiError with server message on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(res(500, { message: 'boom' }))
    await expect(request('/cameras')).rejects.toMatchObject({ status: 500, message: 'boom' })
  })

  it('login stores the session without bearer', async () => {
    useAuth.getState().clear()
    fetchMock.mockResolvedValueOnce(res(200, { access_token: 'x', refresh_token: 'y', user }))
    await login('v@x.io', 'pw')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: 'v@x.io', password: 'pw' })
    expect(authHeader(0)).toBeUndefined()
    expect(useAuth.getState().accessToken).toBe('x')
  })

  it('logout posts refresh token and clears even if the call fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await logout()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/auth/logout`)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ refresh_token: 'r1' })
    expect(useAuth.getState().isAuthenticated()).toBe(false)
  })

  it('builds event query and snapshot source', async () => {
    fetchMock.mockResolvedValueOnce(res(200, []))
    await listEvents({ camera_id: 'c1', limit: 20 })
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/events?camera_id=c1&limit=20`)
    expect(snapshotSource('c1', 3)).toEqual({
      uri: `${BASE}/cameras/c1/snapshot?t=3`,
      headers: { Authorization: 'Bearer a1' },
    })
  })
})
