import type { LandmarkInput, NormBox, RawBox } from '@/types/api'

export interface Size {
  width: number
  height: number
}
export interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}
export interface Point {
  x: number
  y: number
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function round(n: number, places = 4): number {
  const f = 10 ** places
  return Math.round(n * f) / f
}

/** Client pointer position -> normalized [0,1] point inside `rect` (clamped). */
export function pointToNorm(clientX: number, clientY: number, rect: PixelRect): Point {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
  return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) }
}

/** Two corner points (any order) -> normalized box. */
export function boxFromPoints(a: Point, b: Point): NormBox {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

/** Keep the box fully inside the unit square. */
export function clampBox(b: NormBox): NormBox {
  const x = clamp01(b.x)
  const y = clamp01(b.y)
  return { x, y, w: Math.min(Math.max(b.w, 0), 1 - x), h: Math.min(Math.max(b.h, 0), 1 - y) }
}

export function pixelsToNorm(px: PixelRect, size: Size): NormBox {
  return clampBox({
    x: px.left / size.width,
    y: px.top / size.height,
    w: px.width / size.width,
    h: px.height / size.height,
  })
}

export function normToPixels(box: NormBox, size: Size): PixelRect {
  return { left: box.x * size.width, top: box.y * size.height, width: box.w * size.width, height: box.h * size.height }
}

/** Ignore accidental clicks / slivers. */
export function isUsableBox(b: NormBox, min = 0.01): boolean {
  return b.w >= min && b.h >= min
}

export function toTuple(b: NormBox): LandmarkInput['box'] {
  return [round(b.x), round(b.y), round(b.w), round(b.h)]
}

export function fromRawBox(raw: RawBox | null | undefined): NormBox {
  if (Array.isArray(raw)) return { x: raw[0] ?? 0, y: raw[1] ?? 0, w: raw[2] ?? 0, h: raw[3] ?? 0 }
  if (raw && typeof raw === 'object') return { x: raw.x, y: raw.y, w: raw.w, h: raw.h }
  return { x: 0, y: 0, w: 0, h: 0 }
}

export function boxesEqual(a: NormBox, b: NormBox, eps = 1e-4): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps
}

/** CSS percent style for absolutely positioning a box over a frame. */
export function boxStyle(b: NormBox): { left: string; top: string; width: string; height: string } {
  const pct = (n: number) => `${round(n * 100, 3)}%`
  return { left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) }
}

/** Ids whose box moved since the previous poll (auto-calibration). New ids don't count. */
export function movedIds(prev: Map<string, NormBox>, next: { id: string; box: NormBox }[]): string[] {
  return next
    .filter((l) => {
      const p = prev.get(l.id)
      return p !== undefined && !boxesEqual(p, l.box)
    })
    .map((l) => l.id)
}
