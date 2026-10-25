import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccessToken, useReconnectingSocket, wsUrl, type SocketStatus } from './socket'

/** Binary WS payload (ArrayBuffer / Blob / typed array) -> JPEG Blob, else null. */
export function frameToBlob(data: unknown): Blob | null {
  if (data instanceof Blob) return data
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data as BlobPart], { type: 'image/jpeg' })
  return null
}

/**
 * Live JPEG frames from `GET /cameras/:id/stream?token=` as an object URL for an <img>.
 * Revokes superseded frame URLs and on unmount. `url` stays null until a frame arrives
 * (callers fall back to snapshot polling).
 */
export function useCameraStream(cameraId: string | undefined, opts: { enabled?: boolean } = {}): { url: string | null; status: SocketStatus } {
  const { enabled = true } = opts
  const token = useAccessToken()
  const [frame, setFrame] = useState<{ id: string; url: string } | null>(null)
  const current = useRef<string | null>(null)

  const onMessage = useCallback(
    (data: unknown) => {
      const blob = frameToBlob(data)
      if (!blob || !cameraId) return
      const next = URL.createObjectURL(blob)
      if (current.current) URL.revokeObjectURL(current.current)
      current.current = next
      setFrame({ id: cameraId, url: next })
    },
    [cameraId],
  )

  const on = enabled && !!cameraId && !!token
  const status = useReconnectingSocket({
    url: on ? wsUrl(`/cameras/${cameraId}/stream`, token as string) : null,
    binary: true,
    onMessage,
  })

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current)
      current.current = null
    },
    [],
  )

  return { url: on && frame?.id === cameraId ? frame.url : null, status }
}
