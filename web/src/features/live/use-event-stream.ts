import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { cameraKeys } from '@/features/cameras/api'
import { landmarkKeys } from '@/features/landmarks/api'
import type { CameraEvent } from '@/types/api'
import { parseLiveEvent, pushEvent } from './events'
import { useAccessToken, useReconnectingSocket, wsUrl, type SocketStatus } from './socket'

/**
 * Live feed from `GET /ws/events?token=`. Returns newest-first events received since
 * mount plus the connection status. Calibration / health events also refresh the
 * landmark and camera queries so the UI follows the worker.
 */
export function useEventStream(opts: { enabled?: boolean; max?: number } = {}): { events: CameraEvent[]; status: SocketStatus } {
  const { enabled = true, max = 100 } = opts
  const token = useAccessToken()
  const qc = useQueryClient()
  const [events, setEvents] = useState<CameraEvent[]>([])

  const onMessage = useCallback(
    (data: unknown) => {
      const e = parseLiveEvent(data)
      if (!e) return
      setEvents((list) => pushEvent(list, e, max))
      if (e.kind === 'calibration') void qc.invalidateQueries({ queryKey: landmarkKeys.all })
      if (e.kind === 'health') void qc.invalidateQueries({ queryKey: cameraKeys.all })
    },
    [qc, max],
  )

  const status = useReconnectingSocket({
    url: enabled && token ? wsUrl('/ws/events', token) : null,
    onMessage,
  })
  return { events, status }
}
