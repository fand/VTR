/** Pure screen-space geometry for the curve editor: point/curve hit-testing
 *  and coordinate mapping, shared by the canvas painter and the pointer
 *  handlers. No DOM here so it unit-tests with vitest. */

export const PAD = 10

export interface Scale {
  tMin: number
  tRange: number
  innerW: number
  innerH: number
}

/** The subset of a property the geometry needs (value scale + points). */
export interface GeomProp {
  min: number
  max: number
  points: { t: number; v: number }[]
}

export const xAt = (s: Scale, t: number): number =>
  PAD + ((t - s.tMin) / s.tRange) * (s.innerW - 2 * PAD)

export const yAt = (s: Scale, p: { min: number; max: number }, v: number): number =>
  p.max === p.min ? s.innerH / 2 : PAD + (1 - (v - p.min) / (p.max - p.min)) * (s.innerH - 2 * PAD)

export const tAt = (s: Scale, px: number): number =>
  s.tMin + ((px - PAD) / Math.max(s.innerW - 2 * PAD, 1)) * s.tRange

export const vAt = (s: Scale, p: { min: number; max: number }, py: number): number =>
  p.max === p.min
    ? p.min
    : p.min + (1 - (py - PAD) / Math.max(s.innerH - 2 * PAD, 1)) * (p.max - p.min)

/** Nearest point within `radius` px. Ties go to the later (topmost-drawn)
 *  property/point, matching the old SVG paint order. */
export function hitPoint(
  props: GeomProp[],
  s: Scale,
  pos: { x: number; y: number },
  radius: number
): { prop: number; point: number } | null {
  let best: { prop: number; point: number } | null = null
  let bestD = radius * radius
  props.forEach((p, pi) => {
    p.points.forEach((pt, i) => {
      const dx = xAt(s, pt.t) - pos.x
      const dy = yAt(s, p, pt.v) - pos.y
      const d = dx * dx + dy * dy
      if (d <= bestD) {
        bestD = d
        best = { prop: pi, point: i }
      }
    })
  })
  return best
}

function segDist2(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const u = len2 === 0 ? 0 : Math.min(Math.max(((px - x1) * dx + (py - y1) * dy) / len2, 0), 1)
  const cx = x1 + u * dx - px
  const cy = y1 + u * dy - py
  return cx * cx + cy * cy
}

/** Nearest step-after curve line within `radius` px; returns the prop index.
 *  Ties go to the later (topmost-drawn) property. */
export function hitCurve(
  props: GeomProp[],
  s: Scale,
  pos: { x: number; y: number },
  radius: number
): number | null {
  let best: number | null = null
  let bestD = radius * radius
  props.forEach((p, pi) => {
    for (let i = 1; i < p.points.length; i++) {
      const x0 = xAt(s, p.points[i - 1].t)
      const y0 = yAt(s, p, p.points[i - 1].v)
      const x1 = xAt(s, p.points[i].t)
      const y1 = yAt(s, p, p.points[i].v)
      // Step-after: horizontal run at the previous value, then a vertical jump.
      const d = Math.min(
        segDist2(pos.x, pos.y, x0, y0, x1, y0),
        segDist2(pos.x, pos.y, x1, y0, x1, y1)
      )
      if (d <= bestD) {
        bestD = d
        best = pi
      }
    }
  })
  return best
}

/** Index range [lo, hi] (inclusive) of points whose t falls in [t0, t1],
 *  widened by one on each side so step lines continue past the viewport.
 *  Points must be sorted by t. Returns [0, -1] when nothing is visible. */
export function visibleRange(points: { t: number }[], t0: number, t1: number): [number, number] {
  const n = points.length
  if (n === 0 || points[0].t > t1 || points[n - 1].t < t0) return [0, -1]
  // lo: first index with t >= t0.
  let a = 0
  let b = n
  while (a < b) {
    const m = (a + b) >> 1
    if (points[m].t < t0) a = m + 1
    else b = m
  }
  const lo = a
  // hi: last index with t <= t1.
  b = n
  while (a < b) {
    const m = (a + b) >> 1
    if (points[m].t <= t1) a = m + 1
    else b = m
  }
  const hi = a - 1
  return [Math.max(0, lo - 1), Math.min(n - 1, hi + 1)]
}
