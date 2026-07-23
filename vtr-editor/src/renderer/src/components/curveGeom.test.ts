import { expect, test } from 'vitest'
import {
  PAD,
  fitZoomX,
  hitCurve,
  hitPoint,
  tAt,
  vAt,
  valueAt,
  visibleRange,
  xAt,
  yAt,
  type Scale
} from './curveGeom'

// 100px of drawable width/height (innerW/H = 120 with PAD 10 each side).
const s: Scale = { tMin: 0, tRange: 10, innerW: 120, innerH: 120 }
const p01 = (
  points: { t: number; v: number }[]
): { min: number; max: number; points: typeof points } => ({
  min: 0,
  max: 1,
  points
})

test('xAt/tAt and yAt/vAt round-trip', () => {
  expect(xAt(s, 0)).toBe(PAD)
  expect(xAt(s, 10)).toBe(110)
  expect(tAt(s, xAt(s, 3.7))).toBeCloseTo(3.7, 9)
  const p = p01([])
  expect(yAt(s, p, 1)).toBe(PAD)
  expect(yAt(s, p, 0)).toBe(110)
  expect(vAt(s, p, yAt(s, p, 0.25))).toBeCloseTo(0.25, 9)
})

test('degenerate value scale centers vertically', () => {
  const flat = { min: 0.5, max: 0.5 }
  expect(yAt(s, flat, 0.5)).toBe(60)
  expect(vAt(s, flat, 60)).toBe(0.5)
})

test('hitPoint finds the nearest point within radius', () => {
  const props = [p01([{ t: 2, v: 0.5 }]), p01([{ t: 5, v: 0.5 }])]
  const at5 = { x: xAt(s, 5), y: yAt(s, props[1], 0.5) }
  expect(hitPoint(props, s, { x: at5.x + 4, y: at5.y }, 6)).toEqual({ prop: 1, point: 0 })
  expect(hitPoint(props, s, { x: at5.x + 7, y: at5.y }, 6)).toBeNull()
})

test('hitPoint tie goes to the later (topmost) property', () => {
  const props = [p01([{ t: 5, v: 0.5 }]), p01([{ t: 5, v: 0.5 }])]
  const pos = { x: xAt(s, 5), y: yAt(s, props[0], 0.5) }
  expect(hitPoint(props, s, pos, 6)).toEqual({ prop: 1, point: 0 })
})

test('hitCurve hits horizontal and vertical step segments', () => {
  // Step-after: horizontal at v=0 from t=0..5, vertical jump at t=5 to v=1.
  const props = [
    p01([
      { t: 0, v: 0 },
      { t: 5, v: 1 }
    ])
  ]
  const yLow = yAt(s, props[0], 0)
  const xJump = xAt(s, 5)
  // On the horizontal run.
  expect(hitCurve(props, s, { x: xAt(s, 2.5), y: yLow + 3 }, 5)).toBe(0)
  // On the vertical jump.
  expect(hitCurve(props, s, { x: xJump + 3, y: yAt(s, props[0], 0.5) }, 5)).toBe(0)
  // Far away.
  expect(hitCurve(props, s, { x: xAt(s, 2.5), y: yAt(s, props[0], 0.9) }, 5)).toBeNull()
  // Single point: no segments, never hits.
  expect(
    hitCurve([p01([{ t: 5, v: 0.5 }])], s, { x: xJump, y: yAt(s, props[0], 0.5) }, 5)
  ).toBeNull()
})

test('valueAt evaluates the step-after curve', () => {
  const pts = [
    { t: 1, v: 0.1 },
    { t: 2, v: 0.5 },
    { t: 4, v: 0.9 }
  ]
  expect(valueAt(pts, 0)).toBe(0.1) // before the first point
  expect(valueAt(pts, 1)).toBe(0.1) // at a point
  expect(valueAt(pts, 1.5)).toBe(0.1) // on the flat run
  expect(valueAt(pts, 3)).toBe(0.5)
  expect(valueAt(pts, 9)).toBe(0.9) // after the last point
})

test('fitZoomX makes the target span the drawable width', () => {
  const fit = fitZoomX(120, 0, 10, 2, 7, 50)
  expect(fit).not.toBeNull()
  const fs: Scale = { tMin: 0, tRange: 10, innerW: 120 * fit!.zoomX, innerH: 0 }
  expect(xAt(fs, 7) - xAt(fs, 2)).toBeCloseTo(120 - 2 * PAD, 9)
  // Centered target ≡ left edge at selT0.
  expect(fit!.scrollLeft).toBeCloseTo(xAt(fs, 2) - PAD, 9)
})

test('fitZoomX clamps to 1 for the full time range', () => {
  expect(fitZoomX(120, 0, 10, 0, 10, 50)).toEqual({ zoomX: 1, scrollLeft: 0 })
})

test('fitZoomX zooms to max and centers on a single point', () => {
  const fit = fitZoomX(120, 0, 10, 5, 5, 50)
  expect(fit!.zoomX).toBe(50)
  const fs: Scale = { tMin: 0, tRange: 10, innerW: 6000, innerH: 0 }
  expect(fit!.scrollLeft).toBeCloseTo(xAt(fs, 5) - 60, 9)
})

test('fitZoomX clamps scrollLeft at the domain edges', () => {
  expect(fitZoomX(120, 0, 10, 0, 0, 50)!.scrollLeft).toBe(0)
  expect(fitZoomX(120, 0, 10, 10, 10, 50)!.scrollLeft).toBe(6000 - 120)
})

test('fitZoomX returns null for unmeasured panel or empty target', () => {
  expect(fitZoomX(0, 0, 10, 2, 7, 50)).toBeNull()
  expect(fitZoomX(20, 0, 10, 2, 7, 50)).toBeNull()
  expect(fitZoomX(120, 0, 10, 7, 2, 50)).toBeNull()
})

test('visibleRange widens by one point each side', () => {
  const pts = [0, 1, 2, 3, 4, 5].map((t) => ({ t }))
  expect(visibleRange(pts, 2, 3)).toEqual([1, 4])
  expect(visibleRange(pts, 0, 5)).toEqual([0, 5])
  expect(visibleRange(pts, 2.5, 2.6)).toEqual([2, 3])
  expect(visibleRange(pts, 7, 9)).toEqual([0, -1])
  expect(visibleRange([], 0, 1)).toEqual([0, -1])
})
