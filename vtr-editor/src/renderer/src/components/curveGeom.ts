/** Pure screen-space geometry for the curve editor: point/curve hit-testing
 *  and coordinate mapping, shared by the canvas painter and the pointer
 *  handlers. No DOM here so it unit-tests with vitest. */
import { evalCurve, segmentCtrl } from '../../../shared/curve'
import type { CurveKnot } from '../../../shared/types'

export const PAD = 10

export interface Scale {
  tMin: number
  tRange: number
  innerW: number
  innerH: number
}

/** One element of a property's merged curve, in timeline space: a discrete
 *  point or a bezier span (`curve` indexes the prop's own curve list). */
export type GeomEl = { t: number; v: number } | { t: number; knots: CurveKnot[]; curve: number }

/** The subset of a property the geometry needs (value scale + points). */
export interface GeomProp {
  min: number
  max: number
  points: { t: number; v: number }[]
  /** Points + curve spans merged, sorted by t. Absent = points only. */
  els?: GeomEl[]
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

/** Step-after curve value at time t: the last point at or before t, or the
 *  first point's value before any point. Points must be sorted by t. */
export const valueAt = (points: { t: number; v: number }[], t: number): number => {
  let v = points[0].v
  for (const pt of points) {
    if (pt.t > t) break
    v = pt.v
  }
  return v
}

/** Merged curve value at time t: the last-started element wins — a point
 *  holds its value, a curve interpolates inside its span and holds its end
 *  value after. Before every element the first one's flat-left value
 *  applies. Null when the property is empty. */
export function mergedValueAt(p: GeomProp, t: number): number | null {
  const els: readonly GeomEl[] = p.els ?? p.points
  if (els.length === 0) return null
  let v: number | null = null
  for (const el of els) {
    if (el.t > t) break
    v = 'knots' in el ? evalCurve(el.knots, t) : el.v
  }
  if (v == null) {
    const el = els[0]
    v = 'knots' in el ? el.knots[0].v : el.v
  }
  return v
}

/** X zoom + scrollLeft that make [selT0, selT1] span the viewport width.
 *  Zoom clamps to [1, maxZoom]; a zero-width target zooms to maxZoom and
 *  centers on it. Returns null when the panel is unmeasured or the target
 *  is empty. */
export function fitZoomX(
  w: number,
  tMin: number,
  tRange: number,
  selT0: number,
  selT1: number,
  maxZoom: number
): { zoomX: number; scrollLeft: number } | null {
  if (w <= 2 * PAD || selT1 < selT0) return null
  const selRange = selT1 - selT0
  // Solve (selRange / tRange) * (w * zoomX - 2 * PAD) = w - 2 * PAD.
  const raw = selRange <= 0 ? maxZoom : ((w - 2 * PAD) * (tRange / selRange) + 2 * PAD) / w
  const zoomX = Math.min(Math.max(raw, 1), maxZoom)
  const s: Scale = { tMin, tRange, innerW: w * zoomX, innerH: 0 }
  const mid = xAt(s, (selT0 + selT1) / 2)
  const scrollLeft = Math.min(Math.max(mid - w / 2, 0), w * zoomX - w)
  return { zoomX, scrollLeft }
}

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

export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void
}

/**
 * Walk one property's merged path — step-after between discrete values,
 * cubic beziers across curve spans, a hold + jump connecting the two — so a
 * property always draws as a single curve. Culled to elements starting in
 * [t0, t1], widened by one so entering/leaving lines continue offscreen (a
 * curve span reaching into the window from further left is caught too).
 */
export function walkMerged(p: GeomProp, s: Scale, t0: number, t1: number, sink: PathSink): void {
  const els: readonly GeomEl[] = p.els ?? p.points
  const n = els.length
  if (n === 0) return
  // Nothing extends right of the last element or left of the first.
  const lastEl = els[n - 1]
  const lastEnd = 'knots' in lastEl ? lastEl.knots[lastEl.knots.length - 1].t : lastEl.t
  if (lastEnd < t0 || els[0].t > t1) return
  // lo: one before the first element starting at/after t0.
  let a = 0
  let b = n
  while (a < b) {
    const m = (a + b) >> 1
    if (els[m].t < t0) a = m + 1
    else b = m
  }
  let lo = Math.max(0, a - 1)
  // A curve span can start left of lo yet reach into the window; walk from
  // the earliest such curve (linear, but only on props that have curves).
  if (p.els) {
    for (let i = 0; i < lo; i++) {
      const el = els[i]
      if ('knots' in el && el.knots[el.knots.length - 1].t >= t0) {
        lo = i
        break
      }
    }
  }
  // hi: one past the last element starting at/before t1.
  b = n
  while (a < b) {
    const m = (a + b) >> 1
    if (els[m].t <= t1) a = m + 1
    else b = m
  }
  const hi = Math.min(n - 1, a)
  let prevY: number | null = null
  let penX = -Infinity
  const step = (px: number, py: number): void => {
    // Overlapping spans (hand-edited files) can step backwards; clamp so
    // the step lines never draw leftwards.
    const x = Math.max(px, penX)
    if (prevY == null) sink.moveTo(x, py)
    else {
      sink.lineTo(x, prevY)
      sink.lineTo(x, py)
    }
    penX = x
    prevY = py
  }
  for (let i = lo; i <= hi; i++) {
    const el = els[i]
    if ('knots' in el) {
      const kn = el.knots
      step(xAt(s, kn[0].t), yAt(s, p, kn[0].v))
      for (let j = 1; j < kn.length; j++) {
        const [, p1, p2, p3] = segmentCtrl(kn[j - 1], kn[j])
        sink.bezierTo(
          xAt(s, p1.x),
          yAt(s, p, p1.y),
          xAt(s, p2.x),
          yAt(s, p, p2.y),
          xAt(s, p3.x),
          yAt(s, p, p3.y)
        )
      }
      penX = Math.max(penX, xAt(s, kn[kn.length - 1].t))
      prevY = yAt(s, p, kn[kn.length - 1].v)
    } else {
      step(xAt(s, el.t), yAt(s, p, el.v))
    }
  }
}

/** Samples per bezier segment when flattening for hit-testing. */
const HIT_SAMPLES = 12

/** Nearest merged curve line (step lines + flattened beziers) within
 *  `radius` px; returns the prop index. Ties go to the later
 *  (topmost-drawn) property. */
export function hitCurve(
  props: GeomProp[],
  s: Scale,
  pos: { x: number; y: number },
  radius: number
): number | null {
  let best: number | null = null
  let bestD = radius * radius
  const t0 = tAt(s, pos.x - radius)
  const t1 = tAt(s, pos.x + radius)
  props.forEach((p, pi) => {
    let lx = 0
    let ly = 0
    const seg = (x2: number, y2: number): void => {
      const d = segDist2(pos.x, pos.y, lx, ly, x2, y2)
      if (d <= bestD) {
        bestD = d
        best = pi
      }
      lx = x2
      ly = y2
    }
    walkMerged(p, s, t0, t1, {
      moveTo(x, y) {
        lx = x
        ly = y
      },
      lineTo: seg,
      bezierTo(x1, y1, x2, y2, x3, y3) {
        const p0x = lx
        const p0y = ly
        for (let k = 1; k <= HIT_SAMPLES; k++) {
          const u = k / HIT_SAMPLES
          const w = 1 - u
          const b0 = w * w * w
          const b1 = 3 * u * w * w
          const b2 = 3 * u * u * w
          const b3 = u * u * u
          seg(b0 * p0x + b1 * x1 + b2 * x2 + b3 * x3, b0 * p0y + b1 * y1 + b2 * y2 + b3 * y3)
        }
      }
    })
  })
  return best
}

/** Nearest bezier knot within `radius` px. `curve` indexes the prop's curve
 *  list, `knot` the knot within it. Ties go to the later drawn. */
export function hitKnot(
  props: { min: number; max: number; curves: { knots: { t: number; v: number }[] }[] }[],
  s: Scale,
  pos: { x: number; y: number },
  radius: number
): { prop: number; curve: number; knot: number } | null {
  let best: { prop: number; curve: number; knot: number } | null = null
  let bestD = radius * radius
  props.forEach((p, pi) => {
    p.curves.forEach((c, ci) => {
      c.knots.forEach((k, ki) => {
        const dx = xAt(s, k.t) - pos.x
        const dy = yAt(s, p, k.v) - pos.y
        const d = dx * dx + dy * dy
        if (d <= bestD) {
          bestD = d
          best = { prop: pi, curve: ci, knot: ki }
        }
      })
    })
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
