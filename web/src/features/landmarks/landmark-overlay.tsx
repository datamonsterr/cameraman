import { useRef, useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import type { Landmark, NormBox } from '@/types/api'
import { boxFromPoints, boxStyle, isUsableBox, pointToNorm, type Point } from './geometry'

/**
 * Absolutely-positioned layer that sits over a frame (same box as the image). Renders
 * landmark rectangles and, in drawing mode, lets the user drag a new one.
 */
export function LandmarkOverlay({
  landmarks,
  drawing,
  draft,
  highlight,
  onDraw,
}: {
  landmarks: Landmark[]
  drawing: boolean
  /** A drawn-but-unsaved box to keep showing while the name is entered. */
  draft?: NormBox | null
  highlight?: Set<string>
  onDraw: (box: NormBox) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [start, setStart] = useState<Point | null>(null)
  const [current, setCurrent] = useState<Point | null>(null)

  const point = (e: PointerEvent) =>
    pointToNorm(e.clientX, e.clientY, ref.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 })

  function down(e: PointerEvent) {
    if (!drawing) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const p = point(e)
    setStart(p)
    setCurrent(p)
  }
  function move(e: PointerEvent) {
    if (start) setCurrent(point(e))
  }
  function up(e: PointerEvent) {
    if (!start) return
    const box = boxFromPoints(start, point(e))
    setStart(null)
    setCurrent(null)
    if (isUsableBox(box)) onDraw(box)
  }

  const live = start && current ? boxFromPoints(start, current) : null
  const pending = live ?? draft ?? null

  return (
    <div
      ref={ref}
      data-testid="landmark-overlay"
      className={cn('absolute inset-0', drawing ? 'cursor-crosshair touch-none' : 'pointer-events-none')}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        setStart(null)
        setCurrent(null)
      }}
    >
      {landmarks.map((l) => (
        <div
          key={l.id}
          data-testid={`landmark-box-${l.id}`}
          style={boxStyle(l.box)}
          className={cn(
            'pointer-events-none absolute border-2 border-emerald-400/90 transition-all duration-700',
            highlight?.has(l.id) && 'border-amber-300 shadow-[0_0_0_2px_rgba(252,211,77,0.5)]',
          )}
        >
          <span className="absolute -top-5 left-0 rounded bg-black/70 px-1 text-[10px] whitespace-nowrap text-white">{l.name}</span>
        </div>
      ))}
      {pending && <div style={boxStyle(pending)} className="pointer-events-none absolute border-2 border-dashed border-sky-400 bg-sky-400/10" />}
    </div>
  )
}
