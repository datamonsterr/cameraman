import type { Camera } from '@/types/api'

export function makeCamera(over: Partial<Camera> = {}): Camera {
  return {
    id: 'c1', name: 'Front door', vendor: null, host: '192.168.1.38', port: 554, rtsp_path: '/stream1',
    rtsp_username: null, transport: 'tcp', status: 'online', status_reason: null, last_seen_at: null,
    width: null, height: null, codec: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}
