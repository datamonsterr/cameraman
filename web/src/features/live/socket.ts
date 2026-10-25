import { useEffect, useRef, useState } from 'react'
import { apiBaseUrl } from '@/lib/api'
import { useAuth } from '@/stores/auth'

export type SocketStatus = 'connecting' | 'open' | 'closed'

/** `http(s)://host/api/v1` + path (+ `?token=`) -> `ws(s)://...`. */
export function wsUrl(path: string, token: string, base: string = apiBaseUrl()): string {
  const root = base.replace(/^http/i, 'ws').replace(/\/+$/, '')
  const sep = path.includes('?') ? '&' : '?'
  return `${root}${path}${sep}token=${encodeURIComponent(token)}`
}

/** Exponential backoff: base * 2^attempt, capped. */
export function backoffDelay(attempt: number, base = 500, max = 15_000): number {
  return Math.min(max, base * 2 ** Math.max(0, attempt))
}

export function useAccessToken(): string | null {
  return useAuth((s) => s.accessToken)
}

interface Options {
  /** null disables the connection. */
  url: string | null
  binary?: boolean
  onMessage: (data: unknown) => void
  baseDelay?: number
  maxDelay?: number
}

/**
 * Connects to `url`, reconnects with exponential backoff after drops, resets the
 * backoff once a connection opens, and cleans up on unmount / url change.
 */
export function useReconnectingSocket({ url, binary = false, onMessage, baseDelay = 500, maxDelay = 15_000 }: Options): SocketStatus {
  const handler = useRef(onMessage)
  useEffect(() => {
    handler.current = onMessage
  })
  const [state, setState] = useState<{ url: string | null; status: SocketStatus }>({ url, status: 'connecting' })

  useEffect(() => {
    if (!url) return
    let disposed = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | undefined

    const connect = () => {
      let socket: WebSocket
      try {
        socket = new WebSocket(url)
      } catch {
        schedule()
        return
      }
      ws = socket
      if (binary) socket.binaryType = 'arraybuffer'
      socket.onopen = () => {
        attempt = 0
        setState({ url, status: 'open' })
      }
      socket.onmessage = (e: MessageEvent) => handler.current(e.data)
      socket.onerror = () => {
        // 'close' always follows; reconnect is scheduled there.
      }
      socket.onclose = () => {
        if (disposed) return
        setState({ url, status: 'closed' })
        schedule()
      }
    }

    const schedule = () => {
      if (disposed) return
      const delay = backoffDelay(attempt, baseDelay, maxDelay)
      attempt += 1
      timer = setTimeout(() => {
        if (disposed) return
        setState({ url, status: 'connecting' })
        connect()
      }, delay)
    }

    connect()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        ws.close()
      }
    }
  }, [url, binary, baseDelay, maxDelay])

  if (!url) return 'closed'
  return state.url === url ? state.status : 'connecting'
}
