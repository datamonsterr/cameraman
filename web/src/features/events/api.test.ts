import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '@/lib/api'
import { buildEventQuery, fetchEvents } from './api'

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: { get: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

describe('buildEventQuery', () => {
  const now = Date.parse('2026-01-02T00:00:00Z')
  it('omits empty filters and always sets limit', () => {
    expect(buildEventQuery({ kind: '', severity: '', range: 'all' }, 20, now)).toBe('limit=20')
  })
  it('encodes all filters, with since computed from range', () => {
    const q = new URLSearchParams(buildEventQuery({ kind: 'health', severity: 'alert', camera_id: 'c1', range: '24h' }, 50, now))
    expect(Object.fromEntries(q)).toEqual({
      kind: 'health', severity: 'alert', camera_id: 'c1', since: '2026-01-01T00:00:00.000Z', limit: '50',
    })
  })
})

describe('fetchEvents', () => {
  it('sorts newest first', async () => {
    vi.mocked(api.get).mockResolvedValue([
      { id: 1, created_at: '2026-01-01T00:00:00Z' },
      { id: 2, created_at: '2026-01-02T00:00:00Z' },
    ])
    expect((await fetchEvents()).map((e) => e.id)).toEqual([2, 1])
  })
  it('degrades to empty on 404', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(404, 'nf'))
    expect(await fetchEvents()).toEqual([])
  })
  it('rethrows other errors', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(500, 'bad'))
    await expect(fetchEvents()).rejects.toThrow('bad')
  })
})
