import type { Camera, CameraStatus } from '@/types/api'

export function countByStatus(cameras: Camera[]): Record<CameraStatus, number> {
  const out: Record<CameraStatus, number> = { online: 0, connecting: 0, discovered: 0, offline: 0, error: 0 }
  for (const c of cameras) out[c.status] += 1
  return out
}
