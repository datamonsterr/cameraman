import { useEffect, useState } from 'react'
import { fetchSnapshotBlob } from './api'

export interface SnapshotState {
  url: string | null
  error: string | null
  loading: boolean
}

/**
 * Poll a camera snapshot into an object URL. Keeps the last good frame on transient
 * errors, revokes superseded URLs, aborts in-flight requests and pauses when hidden.
 */
export function useSnapshot(
  cameraId: string | undefined,
  opts: { intervalMs?: number; enabled?: boolean; fetcher?: typeof fetchSnapshotBlob } = {},
): SnapshotState {
  const { intervalMs = 3000, enabled = true, fetcher = fetchSnapshotBlob } = opts
  const [state, setState] = useState<SnapshotState>({ url: null, error: null, loading: true })

  useEffect(() => {
    if (!cameraId || !enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: string | null = null
    const ctrl = new AbortController()

    const tick = async () => {
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, intervalMs)
        return
      }
      try {
        const blob = await fetcher(cameraId, ctrl.signal)
        if (cancelled) return
        const next = URL.createObjectURL(blob)
        if (current) URL.revokeObjectURL(current)
        current = next
        setState({ url: next, error: null, loading: false })
      } catch (e) {
        if (cancelled) return
        setState((s) => ({ url: s.url, loading: false, error: e instanceof Error ? e.message : 'Snapshot failed' }))
      }
      if (!cancelled) timer = setTimeout(tick, intervalMs)
    }
    void tick()

    return () => {
      cancelled = true
      ctrl.abort()
      if (timer) clearTimeout(timer)
      if (current) URL.revokeObjectURL(current)
    }
  }, [cameraId, enabled, intervalMs, fetcher])

  return state
}
