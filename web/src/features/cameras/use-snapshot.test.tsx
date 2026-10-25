import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSnapshot } from './use-snapshot'

beforeEach(() => {
  vi.useFakeTimers()
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:${++n}`)
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => vi.useRealTimers())

describe('useSnapshot', () => {
  it('creates an object URL, refreshes on the interval and revokes old ones', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Blob(['x']))
    const { result, unmount } = renderHook(() => useSnapshot('c1', { intervalMs: 3000, fetcher }))
    await act(async () => {})
    expect(result.current.url).toBe('blob:1')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.current.url).toBe('blob:2')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:2')
  })

  it('keeps the last frame and reports the error on failure', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Blob(['x'])).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useSnapshot('c1', { intervalMs: 1000, fetcher }))
    await act(async () => {})
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current).toMatchObject({ url: 'blob:1', error: 'boom' })
  })

  it('does not fetch when disabled', async () => {
    const fetcher = vi.fn()
    renderHook(() => useSnapshot('c1', { enabled: false, fetcher }))
    await act(async () => {})
    expect(fetcher).not.toHaveBeenCalled()
  })
})
