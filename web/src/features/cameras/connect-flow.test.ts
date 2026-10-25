import { describe, expect, it, vi } from 'vitest'
import { makeCamera } from '@/test/fixtures'
import { connectReducer, initialConnectState, resultToState, runConnectFlow, type ConnectEvent } from './connect-flow'

const create = { name: 'a', host: 'h' }

describe('resultToState', () => {
  it('maps online', () => expect(resultToState(makeCamera({ status: 'online' })).phase).toBe('online'))
  it('maps 200-with-error to error carrying the reason', () => {
    const s = resultToState(makeCamera({ status: 'error', status_reason: '401 Unauthorized' }))
    expect(s).toMatchObject({ phase: 'error', reason: '401 Unauthorized' })
  })
  it('falls back to a generic reason', () => {
    expect(resultToState(makeCamera({ status: 'error', status_reason: null }))).toMatchObject({ reason: 'Connection failed' })
  })
  it('keeps waiting while connecting', () => {
    expect(resultToState(makeCamera({ id: 'x', status: 'connecting' }))).toEqual({ phase: 'connecting', cameraId: 'x' })
  })
})

describe('connectReducer', () => {
  it('retry after a saved-camera error skips creation', () => {
    const err = connectReducer(initialConnectState, { type: 'failed', reason: 'x', camera: makeCamera({ id: 'k' }) })
    expect(connectReducer(err, { type: 'start' })).toEqual({ phase: 'connecting', cameraId: 'k' })
  })
  it('resets', () => expect(connectReducer({ phase: 'creating' }, { type: 'reset' })).toEqual(initialConnectState))
})

describe('runConnectFlow', () => {
  it('goes creating -> connecting -> online', async () => {
    const cam = makeCamera({ status: 'online' })
    const events: ConnectEvent[] = []
    const final = await runConnectFlow(
      { create: vi.fn().mockResolvedValue(makeCamera({ status: 'discovered' })), connect: vi.fn().mockResolvedValue(cam) },
      { create, credentials: { username: 'u', password: '' } },
      (e) => events.push(e),
    )
    expect(events.map((e) => e.type)).toEqual(['created', 'result'])
    expect(final).toEqual({ phase: 'online', camera: cam })
  })

  it('treats HTTP 200 with status=error as error and sends only provided creds', async () => {
    const connect = vi.fn().mockResolvedValue(makeCamera({ status: 'error', status_reason: 'bad password' }))
    const final = await runConnectFlow(
      { create: vi.fn().mockResolvedValue(makeCamera()), connect },
      { create, credentials: { username: 'u', password: '' } },
      () => {},
    )
    expect(connect).toHaveBeenCalledWith('c1', { username: 'u' })
    expect(final).toMatchObject({ phase: 'error', reason: 'bad password' })
  })

  it('reports create failure without a camera', async () => {
    const final = await runConnectFlow(
      { create: vi.fn().mockRejectedValue(new Error('conflict')), connect: vi.fn() },
      { create },
      () => {},
    )
    expect(final).toEqual({ phase: 'error', reason: 'conflict', camera: undefined })
  })

  it('reuses an existing camera on retry and keeps it when connect throws', async () => {
    const existing = makeCamera({ id: 'e1' })
    const createFn = vi.fn()
    const final = await runConnectFlow(
      { create: createFn, connect: vi.fn().mockRejectedValue(new Error('network')) },
      { create, existing },
      () => {},
    )
    expect(createFn).not.toHaveBeenCalled()
    expect(final).toMatchObject({ phase: 'error', reason: 'network', camera: existing })
  })
})
