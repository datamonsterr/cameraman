import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { makeCamera } from '@/test/fixtures'
import { candidateToCreate, connectCamera, createCamera, deleteCamera, fetchCameras, fetchStatusHistory, scanCameras, updateCamera } from './api'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), blob: vi.fn() },
}))

beforeEach(() => vi.clearAllMocks())

describe('camera query functions', () => {
  it('hits the contract endpoints', async () => {
    vi.mocked(api.get).mockResolvedValue([])
    await fetchCameras()
    await fetchStatusHistory('c1', 10)
    await scanCameras()
    await scanCameras('10.0.0.0/24')
    await createCamera({ name: 'a', host: 'h' })
    await updateCamera('c1', { name: 'b' })
    await connectCamera('c1', { username: 'u' })
    await deleteCamera('c1')
    expect(api.get).toHaveBeenCalledWith('/cameras')
    expect(api.get).toHaveBeenCalledWith('/cameras/c1/status/history?limit=10')
    expect(api.post).toHaveBeenCalledWith('/cameras/scan', {})
    expect(api.post).toHaveBeenCalledWith('/cameras/scan', { cidr: '10.0.0.0/24' })
    expect(api.post).toHaveBeenCalledWith('/cameras', { name: 'a', host: 'h' })
    expect(api.patch).toHaveBeenCalledWith('/cameras/c1', { name: 'b' })
    expect(api.post).toHaveBeenCalledWith('/cameras/c1/connect', { username: 'u' })
    expect(api.delete).toHaveBeenCalledWith('/cameras/c1')
  })

  it('builds a create request from a candidate', () => {
    const c = { host: '1.2.3.4', port: 8554, vendor: 'Acme', paths: ['/live'], requires_auth: true, source: 'onvif' }
    expect(candidateToCreate(c)).toEqual({ name: 'Acme 1.2.3.4', host: '1.2.3.4', port: 8554, rtsp_path: '/live', vendor: 'Acme' })
    expect(candidateToCreate({ ...c, vendor: null, paths: [] }, { name: ' Cam ', rtsp_path: '/x' })).toEqual({
      name: 'Cam', host: '1.2.3.4', port: 8554, rtsp_path: '/x',
    })
    expect(candidateToCreate({ ...c, paths: [] }).rtsp_path).toBe('/')
  })

  it('fixture sanity', () => expect(makeCamera().status).toBe('online'))
})
