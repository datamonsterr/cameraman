import { describe, expect, it } from 'vitest'
import {
  boxFromPoints,
  boxStyle,
  boxesEqual,
  clampBox,
  fromRawBox,
  isUsableBox,
  movedIds,
  normToPixels,
  pixelsToNorm,
  pointToNorm,
  toTuple,
} from './geometry'

const rect = { left: 100, top: 50, width: 400, height: 200 }

describe('landmark geometry', () => {
  it('converts pointer position to clamped normalized coords', () => {
    expect(pointToNorm(300, 150, rect)).toEqual({ x: 0.5, y: 0.5 })
    expect(pointToNorm(0, 0, rect)).toEqual({ x: 0, y: 0 })
    expect(pointToNorm(9999, 9999, rect)).toEqual({ x: 1, y: 1 })
    expect(pointToNorm(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 })
  })

  it('builds a box from two corners in any order', () => {
    expect(boxFromPoints({ x: 0.6, y: 0.8 }, { x: 0.2, y: 0.4 })).toEqual({
      x: 0.2,
      y: 0.4,
      w: expect.closeTo(0.4),
      h: expect.closeTo(0.4),
    })
  })

  it('round-trips pixels <-> normalized', () => {
    const size = { width: 1280, height: 720 }
    const px = { left: 320, top: 180, width: 640, height: 360 }
    const n = pixelsToNorm(px, size)
    expect(n).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    expect(normToPixels(n, size)).toEqual(px)
  })

  it('clamps boxes inside the unit square', () => {
    expect(clampBox({ x: 0.8, y: -0.1, w: 0.5, h: 2 })).toEqual({ x: 0.8, y: 0, w: expect.closeTo(0.2), h: 1 })
  })

  it('rejects slivers', () => {
    expect(isUsableBox({ x: 0, y: 0, w: 0.005, h: 0.5 })).toBe(false)
    expect(isUsableBox({ x: 0, y: 0, w: 0.2, h: 0.2 })).toBe(true)
  })

  it('maps to the API tuple and back, from tuple or object', () => {
    expect(toTuple({ x: 0.123456, y: 0.2, w: 0.3, h: 0.4 })).toEqual([0.1235, 0.2, 0.3, 0.4])
    expect(fromRawBox([0.1, 0.2, 0.3, 0.4])).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
    expect(fromRawBox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
    expect(fromRawBox(null)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('produces percent styles for overlays', () => {
    expect(boxStyle({ x: 0.25, y: 0.5, w: 0.1, h: 0.2 })).toEqual({ left: '25%', top: '50%', width: '10%', height: '20%' })
  })

  it('detects boxes moved by auto-calibration, ignoring new ones', () => {
    const a = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    const prev = new Map([['l1', a], ['l2', a]])
    const next = [
      { id: 'l1', box: a },
      { id: 'l2', box: { ...a, x: 0.12 } },
      { id: 'l3', box: a },
    ]
    expect(movedIds(prev, next)).toEqual(['l2'])
    expect(boxesEqual(a, { ...a, x: 0.10001 })).toBe(true)
  })
})
