import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '@/stores/auth'
import type { CameraEvent } from '@/types/api'
import { matchesFilter, mergeEvents, parseLiveEvent, pushEvent } from './events'
import { backoffDelay, wsUrl } from './socket'
import { frameToBlob, useCameraStream } from './use-camera-stream'
import { useEventStream } from './use-event-stream'

class MockWS {
  static instances: MockWS[] = []
  url: string
  binaryType = 'blob'
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    MockWS.instances.push(this)
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.()
  }
  msg(data: unknown) {
    this.onmessage?.({ data })
  }
  drop() {
    this.onclose?.()
  }
}

const last = () => MockWS.instances[MockWS.instances.length - 1]

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

beforeEach(() => {
  MockWS.instances = []
  vi.stubGlobal('WebSocket', MockWS)
  vi.useFakeTimers()
  useAuth.getState().setSession({
    access_token: 'tok en',
    refresh_token: 'r',
    user: { id: '1', email: 'a@b.co', display_name: 'A', role: 'viewer', is_active: true, created_at: '', updated_at: '' },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useAuth.getState().clear()
})

describe('socket helpers', () => {
  it('builds ws urls with an encoded token', () => {
    expect(wsUrl('/ws/events', 'a b', 'http://h:8080/api/v1/')).toBe('ws://h:8080/api/v1/ws/events?token=a%20b')
    expect(wsUrl('/x?y=1', 't', 'https://h/api')).toBe('wss://h/api/x?y=1&token=t')
  })
  it('backs off exponentially with a cap', () => {
    expect([0, 1, 2, 3].map((n) => backoffDelay(n))).toEqual([500, 1000, 2000, 4000])
    expect(backoffDelay(20)).toBe(15000)
  })
})

describe('event helpers', () => {
  const ev = (id: number, at: string, over: Partial<CameraEvent> = {}): CameraEvent => ({
    id, kind: 'detection', camera_id: 'c1', workflow_id: null, run_id: null, severity: 'info', message: null,
    payload: null, snapshot_id: null, created_at: at, ...over,
  })

  it('parses bare and enveloped events, rejects junk', () => {
    expect(parseLiveEvent(JSON.stringify({ id: 5, kind: 'alert-ish' }))).toBeNull()
    expect(parseLiveEvent('not json')).toBeNull()
    expect(parseLiveEvent(new ArrayBuffer(1))).toBeNull()
    const a = parseLiveEvent(JSON.stringify({ id: 5, kind: 'detection', severity: 'alert', message: 'person', camera_id: 'c1' }))
    expect(a).toMatchObject({ id: 5, kind: 'detection', severity: 'alert', message: 'person', camera_id: 'c1' })
    const b = parseLiveEvent(JSON.stringify({ type: 'event', event: { id: 6, kind: 'health' } }))
    expect(b).toMatchObject({ id: 6, kind: 'health', severity: 'info' })
  })

  it('merges live over fetched without duplicates, newest first', () => {
    const live = [ev(3, '2026-01-01T00:00:03Z'), ev(2, '2026-01-01T00:00:02Z')]
    const fetched = [ev(2, '2026-01-01T00:00:02Z'), ev(1, '2026-01-01T00:00:01Z')]
    expect(mergeEvents(live, fetched, 10).map((e) => e.id)).toEqual([3, 2, 1])
    expect(mergeEvents(live, fetched, 2).map((e) => e.id)).toEqual([3, 2])
  })

  it('prepends unique events and caps', () => {
    let l: CameraEvent[] = []
    l = pushEvent(l, ev(1, 'a'), 2)
    l = pushEvent(l, ev(1, 'a'), 2)
    l = pushEvent(l, ev(2, 'b'), 2)
    l = pushEvent(l, ev(3, 'c'), 2)
    expect(l.map((e) => e.id)).toEqual([3, 2])
  })

  it('filters live events like the REST query', () => {
    const e = ev(1, 'a', { severity: 'alert' })
    expect(matchesFilter(e, {})).toBe(true)
    expect(matchesFilter(e, { severity: 'info' })).toBe(false)
    expect(matchesFilter(e, { camera_id: 'c1', kind: 'detection' })).toBe(true)
    expect(matchesFilter(e, { camera_id: 'other' })).toBe(false)
  })
})

describe('useEventStream', () => {
  it('connects with the token, turns messages into state, and prepends', () => {
    const { result } = renderHook(() => useEventStream(), { wrapper })
    expect(last().url).toContain('/ws/events?token=tok%20en')
    expect(result.current.status).toBe('connecting')
    act(() => last().open())
    expect(result.current.status).toBe('open')
    act(() => last().msg(JSON.stringify({ id: 1, kind: 'detection', message: 'first' })))
    act(() => last().msg(JSON.stringify({ id: 2, kind: 'detection', message: 'second' })))
    act(() => last().msg('garbage'))
    expect(result.current.events.map((e) => e.message)).toEqual(['second', 'first'])
  })

  it('reconnects with backoff after a drop and resets after opening', () => {
    const { result } = renderHook(() => useEventStream(), { wrapper })
    act(() => last().open())
    act(() => last().drop())
    expect(result.current.status).toBe('closed')
    expect(MockWS.instances).toHaveLength(1)
    act(() => vi.advanceTimersByTime(499))
    expect(MockWS.instances).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(MockWS.instances).toHaveLength(2)
    // fails again before opening: delay doubles
    act(() => last().drop())
    act(() => vi.advanceTimersByTime(999))
    expect(MockWS.instances).toHaveLength(2)
    act(() => vi.advanceTimersByTime(1))
    expect(MockWS.instances).toHaveLength(3)
    act(() => last().open())
    expect(result.current.status).toBe('open')
    // backoff reset by successful open
    act(() => last().drop())
    act(() => vi.advanceTimersByTime(500))
    expect(MockWS.instances).toHaveLength(4)
  })

  it('closes the socket and stops reconnecting on unmount', () => {
    const { unmount } = renderHook(() => useEventStream(), { wrapper })
    const ws = last()
    act(() => ws.open())
    unmount()
    expect(ws.closed).toBe(true)
    act(() => vi.advanceTimersByTime(60_000))
    expect(MockWS.instances).toHaveLength(1)
  })

  it('does not connect when disabled or signed out', () => {
    renderHook(() => useEventStream({ enabled: false }), { wrapper })
    expect(MockWS.instances).toHaveLength(0)
    act(() => useAuth.getState().clear())
    renderHook(() => useEventStream(), { wrapper })
    expect(MockWS.instances).toHaveLength(0)
  })
})

describe('useCameraStream', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`)
    URL.revokeObjectURL = vi.fn()
  })

  it('renders binary frames as object URLs and revokes old ones', () => {
    const { result, unmount } = renderHook(() => useCameraStream('cam1'))
    expect(last().url).toContain('/cameras/cam1/stream?token=')
    expect(last().binaryType).toBe('arraybuffer')
    expect(result.current.url).toBeNull()
    act(() => last().open())
    act(() => last().msg(new Uint8Array([0xff, 0xd8]).buffer))
    const first = result.current.url
    expect(first).toMatch(/^blob:/)
    act(() => last().msg(new Uint8Array([0xff, 0xd8, 1]).buffer))
    expect(result.current.url).not.toBe(first)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first)
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('stays idle when disabled (snapshot fallback)', () => {
    const { result } = renderHook(() => useCameraStream('cam1', { enabled: false }))
    expect(MockWS.instances).toHaveLength(0)
    expect(result.current).toEqual({ url: null, status: 'closed' })
  })

  it('ignores non-binary payloads', () => {
    expect(frameToBlob('text')).toBeNull()
    expect(frameToBlob(new Blob(['x']))).toBeInstanceOf(Blob)
  })
})
