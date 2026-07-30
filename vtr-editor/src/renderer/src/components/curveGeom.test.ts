import { expect, test } from 'vitest'
import { unshadowedPoints } from '../../../shared/curve'
import {
  PAD,
  fitZoomX,
  hitCurve,
  hitKnot,
  hitPoint,
  mergedValueAt,
  tAt,
  vAt,
  visibleRange,
  walkMerged,
  xAt,
  yAt,
  type GeomEl,
  type GeomProp,
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

// A point at t=1 (v=0), a linear bezier span t=4..8 rising 0→1: the merged
// path holds v=0 from the point to the span, jumps onto it, then curves.
const mergedProp = (): GeomProp => {
  const knots = [
    { t: 4, v: 0 },
    { t: 8, v: 1 }
  ]
  const els: GeomEl[] = [
    { t: 1, v: 0 },
    { t: 4, knots, curve: 0 }
  ]
  return { min: 0, max: 1, points: [{ t: 1, v: 0 }], els }
}

test('walkMerged draws points and curve spans as one path', () => {
  const cmds: string[] = []
  walkMerged(mergedProp(), s, -Infinity, Infinity, {
    moveTo: (x, y) => cmds.push(`M${x},${y}`),
    lineTo: (x, y) => cmds.push(`L${x},${y}`),
    bezierTo: (...a) => cmds.push(`C${a.map((n) => Math.round(n)).join(',')}`)
  })
  const p = mergedProp()
  const y0 = yAt(s, p, 0)
  // moveTo the point, hold to the span start (same y here), one cubic.
  expect(cmds).toEqual([
    `M${xAt(s, 1)},${y0}`,
    `L${xAt(s, 4)},${y0}`,
    `L${xAt(s, 4)},${y0}`,
    `C${[
      xAt(s, 4 + 4 / 3),
      yAt(s, p, 1 / 3),
      xAt(s, 8 - 4 / 3),
      yAt(s, p, 2 / 3),
      xAt(s, 8),
      yAt(s, p, 1)
    ]
      .map((n) => Math.round(n))
      .join(',')}`
  ])
})

test('walkMerged culls to the window but keeps entering lines', () => {
  const cmds: string[] = []
  // Window over the hold line only: both its endpoints still walk.
  walkMerged(mergedProp(), s, 2, 3, {
    moveTo: () => cmds.push('M'),
    lineTo: () => cmds.push('L'),
    bezierTo: () => cmds.push('C')
  })
  expect(cmds).toEqual(['M', 'L', 'L', 'C'])
  // Window entirely right of everything: nothing walks.
  const none: string[] = []
  walkMerged({ min: 0, max: 1, points: [{ t: 1, v: 0 }] }, s, 5, 9, {
    moveTo: () => none.push('M'),
    lineTo: () => none.push('L'),
    bezierTo: () => none.push('C')
  })
  expect(none).toEqual([])
})

test('hitCurve hits the bezier span and the connecting hold line', () => {
  const p = mergedProp()
  // Mid-span of the linear bezier: t=6 → v=0.5.
  expect(hitCurve([p], s, { x: xAt(s, 6), y: yAt(s, p, 0.5) + 2 }, 5)).toBe(0)
  // On the hold line between the point and the span.
  expect(hitCurve([p], s, { x: xAt(s, 2.5), y: yAt(s, p, 0) - 2 }, 5)).toBe(0)
  // Far off the curve.
  expect(hitCurve([p], s, { x: xAt(s, 6), y: yAt(s, p, 0.95) }, 5)).toBeNull()
})

test('hitKnot finds the nearest knot within radius', () => {
  const p = {
    min: 0,
    max: 1,
    curves: [
      {
        knots: [
          { t: 4, v: 0 },
          { t: 8, v: 1 }
        ]
      }
    ]
  }
  const at8 = { x: xAt(s, 8), y: yAt(s, p, 1) }
  expect(hitKnot([p], s, { x: at8.x + 4, y: at8.y }, 6)).toEqual({ prop: 0, curve: 0, knot: 1 })
  expect(hitKnot([p], s, { x: at8.x + 9, y: at8.y }, 6)).toBeNull()
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

test('mergedValueAt interpolates inside curve spans and steps elsewhere', () => {
  // Linear curve [2,4] ramps 0->1, discrete points at t=6 (0.2) and t=8 (0.7).
  const knots = [
    { t: 2, v: 0 },
    { t: 4, v: 1 }
  ]
  const els: GeomEl[] = [
    { t: 2, knots, curve: 0 },
    { t: 6, v: 0.2 },
    { t: 8, v: 0.7 }
  ]
  const p: GeomProp = { min: 0, max: 1, points: [], els }
  expect(mergedValueAt(p, 1)).toBe(0) // before everything: flat-left
  expect(mergedValueAt(p, 3)).toBeCloseTo(0.5, 9) // inside the span
  expect(mergedValueAt(p, 5)).toBe(1) // after the span: end value holds
  expect(mergedValueAt(p, 7)).toBe(0.2) // the point takes over
  expect(mergedValueAt(p, 9)).toBe(0.7)
  expect(mergedValueAt({ min: 0, max: 1, points: [] }, 0)).toBeNull()
})

// Mirrors conformance_resolver.rs (test_event_vs_curve_latest_definition_wins,
// test_same_time_tie_goes_to_curve): a curve outranks points at/inside its
// span forever, so buildProperties drops them from els (unshadowedPoints)
// and the plain last-started-wins merge below matches the player.
test('mergedValueAt matches the resolver once shadowed points are dropped', () => {
  const knots = [
    { t: 0, v: 0 },
    { t: 4, v: 1 }
  ]
  const points = [
    { t: 2, v: 9 }, // inside the span: never plays
    { t: 4, v: 9 }, // at the span end: tie goes to the curve, never plays
    { t: 6, v: 9 } // after the span: wins from its t
  ]
  const els: GeomEl[] = [
    { t: 0, knots, curve: 0 },
    ...unshadowedPoints(points, [{ start: 0, end: 4 }])
  ].sort((a, b) => a.t - b.t)
  const p: GeomProp = { min: 0, max: 9, points, els }
  expect(mergedValueAt(p, 2)).toBeCloseTo(0.5, 9) // curve, not the point
  expect(mergedValueAt(p, 5)).toBe(1) // end value still wins
  expect(mergedValueAt(p, 6)).toBe(9) // later point takes over
})

test('walkMerged culls by span end, not by the last element', () => {
  // A span outlasting a later-starting element (hand-edited overlap): a
  // window past the short span must still draw the long one.
  const els: GeomEl[] = [
    {
      t: 0,
      knots: [
        { t: 0, v: 0 },
        { t: 8, v: 1 }
      ],
      curve: 0
    },
    {
      t: 2,
      knots: [
        { t: 2, v: 0 },
        { t: 3, v: 0 }
      ],
      curve: 1
    }
  ]
  const p: GeomProp = { min: 0, max: 1, points: [], els }
  const cmds: string[] = []
  walkMerged(p, s, 5, 6, {
    moveTo: () => cmds.push('M'),
    lineTo: () => cmds.push('L'),
    bezierTo: () => cmds.push('C')
  })
  expect(cmds).not.toEqual([])
})
