import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { useAuth } from '@/stores/auth'
import type { User } from '@/types/api'

const user: User = {
  id: 'u1', email: 'a@b.c', display_name: 'A', role: 'admin', is_active: true,
  created_at: '', updated_at: '',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  useAuth.setState({ user, accessToken: 'old-access', refreshToken: 'old-refresh' })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

describe('api client', () => {
  it('attaches bearer token and parses JSON (happy path)', async () => {
    fetchMock.mockResolvedValueOnce(json(200, [{ id: 'c1' }]))
    const res = await api.get<{ id: string }[]>('/cameras')
    expect(res).toEqual([{ id: 'c1' }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8080/api/v1/cameras')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer old-access')
  })

  it('sends JSON bodies on POST', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }))
    await api.post('/cameras', { name: 'x' })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ name: 'x' }))
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
  })

  it('on 401 refreshes once, stores new tokens and retries', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockResolvedValueOnce(json(200, { access_token: 'new-access', refresh_token: 'new-refresh' }))
      .mockResolvedValueOnce(json(200, { ok: 1 }))
    const res = await api.get('/cameras')
    expect(res).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[1]
    expect(refreshUrl).toBe('http://localhost:8080/api/v1/auth/refresh')
    expect(JSON.parse(refreshInit.body)).toEqual({ refresh_token: 'old-refresh' })
    const retryHeaders = new Headers(fetchMock.mock.calls[2][1].headers)
    expect(retryHeaders.get('Authorization')).toBe('Bearer new-access')
    expect(useAuth.getState().accessToken).toBe('new-access')
    expect(useAuth.getState().refreshToken).toBe('new-refresh')
  })

  it('logs out when refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(401, { error: 'bad refresh' }))
    await expect(api.get('/cameras')).rejects.toBeInstanceOf(ApiError)
    expect(useAuth.getState().accessToken).toBeNull()
    expect(useAuth.getState().refreshToken).toBeNull()
    expect(useAuth.getState().user).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not loop: a second 401 after refresh is thrown', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { access_token: 'n', refresh_token: 'r' }))
      .mockResolvedValueOnce(json(401, { error: 'nope' }))
    await expect(api.get('/cameras')).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('shares one refresh across concurrent 401s', async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh'))
        return json(200, { access_token: 'new-access', refresh_token: 'new-refresh' })
      const auth = new Headers(init.headers).get('Authorization')
      return auth === 'Bearer new-access' ? json(200, { ok: 1 }) : json(401, {})
    })
    await Promise.all([api.get('/a'), api.get('/b')])
    const refreshCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'))
    expect(refreshCalls).toHaveLength(1)
  })

  it('skips auth + refresh for public requests (login 401 surfaces as error)', async () => {
    useAuth.setState({ user: null, accessToken: null, refreshToken: null })
    fetchMock.mockResolvedValueOnce(json(401, { error: 'invalid credentials' }))
    await expect(api.post('/auth/login', {}, { auth: false })).rejects.toMatchObject({
      status: 401,
      message: 'invalid credentials',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await api.post('/auth/logout')).toBeUndefined()
  })
})
