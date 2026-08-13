/** Piecewise cubic bezier math over CurveKnot lists: evaluation, clipping
 *  (de Casteljau), and least-squares fitting (Schneider, Graphics Gems
 *  "An Algorithm for Automatically Fitting Digitized Curves"). Pure and
 *  DOM-free: shared by the renderer (fit, drawing) and main (export clip).
 */
import type { CurveKnot } from './types'

interface XY {
  x: number
  y: number
}

/** Control points of the segment between k0 and k1. A missing handle falls
 *  back to the linear third; handle time components are clamped so x stays
 *  inside the segment (readers of hand-edited files get monotone time). */
export function segmentCtrl(k0: CurveKnot, k1: CurveKnot): [XY, XY, XY, XY] {
  const span = k1.t - k0.t
  const p0 = { x: k0.t, y: k0.v }
  const p3 = { x: k1.t, y: k1.v }
  const p1 = k0.o
    ? { x: k0.t + Math.min(Math.max(k0.o[0], 0), span), y: k0.v + k0.o[1] }
    : { x: k0.t + span / 3, y: k0.v + (k1.v - k0.v) / 3 }
  const p2 = k1.i
    ? { x: k1.t + Math.min(Math.max(k1.i[0], -span), 0), y: k1.v + k1.i[1] }
    : { x: k1.t - span / 3, y: k1.v - (k1.v - k0.v) / 3 }
  return [p0, p1, p2, p3]
}

/** De Casteljau evaluation, matching the player exactly: repeated lerps
 *  keep flat spans exactly flat (Bernstein weights drift by ~1 ulp). */
function bezXY(p: [XY, XY, XY, XY], u: number): XY {
  const l = (a: number, b: number): number => a + (b - a) * u
  const q0 = { x: l(p[0].x, p[1].x), y: l(p[0].y, p[1].y) }
  const q1 = { x: l(p[1].x, p[2].x), y: l(p[1].y, p[2].y) }
  const q2 = { x: l(p[2].x, p[3].x), y: l(p[2].y, p[3].y) }
  const r0 = { x: l(q0.x, q1.x), y: l(q0.y, q1.y) }
  const r1 = { x: l(q1.x, q2.x), y: l(q1.y, q2.y) }
  return { x: l(r0.x, r1.x), y: l(r0.y, r1.y) }
}

/** Parameter u where the segment's x(u) = t, by bisection (x is monotone
 *  within the clamped control polygon; bisection still converges to a root
 *  when a hand-written file bends time slightly). */
function paramAt(p: [XY, XY, XY, XY], t: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (bezXY(p, mid).x < t) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Curve value at time t. Extends flat before the first and after the last
 *  knot (the resolver's seek rule for discrete data, applied to curves). */
export function evalCurve(knots: CurveKnot[], t: number): number {
  if (knots.length === 0) return 0
  if (t <= knots[0].t) return knots[0].v
  const last = knots[knots.length - 1]
  if (t >= last.t) return last.v
  // Rightmost knot with knot.t <= t.
  let lo = 0
  let hi = knots.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (knots[mid].t <= t) lo = mid
    else hi = mid
  }
  // Step segment: hold the left value; the jump lands on the right knot.
  if (knots[lo].s) return knots[lo].v
  const p = segmentCtrl(knots[lo], knots[lo + 1])
  return bezXY(p, paramAt(p, t)).y
}

/** The player's event-vs-curve rule (resolver.rs, pinned by
 *  conformance_resolver.rs): once t reaches a span, the curve's definition
 *  time is min(t, span end) and ties go to the curve — so a point at or
 *  inside a span (ends inclusive) is outranked at every t and never plays,
 *  even after the span ends. Drop those; the survivors merge with curves by
 *  plain "latest definition wins". */
export function unshadowedPoints<P extends { t: number }>(
  points: readonly P[],
  spans: readonly { start: number; end: number }[]
): P[] {
  if (spans.length === 0) return [...points]
  return points.filter((p) => !spans.some((s) => s.start <= p.t && p.t <= s.end))
}

/** De Casteljau split of one segment at parameter u: two cubics sharing the
 *  split point. */
function splitCtrl(p: [XY, XY, XY, XY], u: number): [[XY, XY, XY, XY], [XY, XY, XY, XY]] {
  const lerp = (a: XY, b: XY): XY => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u })
  const q0 = lerp(p[0], p[1])
  const q1 = lerp(p[1], p[2])
  const q2 = lerp(p[2], p[3])
  const r0 = lerp(q0, q1)
  const r1 = lerp(q1, q2)
  const s = lerp(r0, r1)
  return [
    [p[0], q0, r0, s],
    [s, r1, q2, p[3]]
  ]
}

/** Rebuild a knot pair from a segment's control points. */
function ctrlToKnots(p: [XY, XY, XY, XY]): [CurveKnot, CurveKnot] {
  return [
    { t: p[0].x, v: p[0].y, o: [p[1].x - p[0].x, p[1].y - p[0].y] },
    { t: p[3].x, v: p[3].y, i: [p[2].x - p[3].x, p[2].y - p[3].y] }
  ]
}

/**
 * Restrict a curve to [t0, t1], splitting boundary segments so the clipped
 * curve traces the original exactly. Returns null when the span and the
 * window don't overlap or the remainder degenerates to a point.
 */
export function clipCurve(knots: CurveKnot[], t0: number, t1: number): CurveKnot[] | null {
  if (knots.length < 2 || t1 <= t0) return null
  const start = knots[0].t
  const end = knots[knots.length - 1].t
  const lo = Math.max(t0, start)
  const hi = Math.min(t1, end)
  if (hi - lo <= 1e-9) return null
  const out: CurveKnot[] = []
  for (let s = 0; s + 1 < knots.length; s++) {
    const a = knots[s]
    const b = knots[s + 1]
    if (b.t <= lo || a.t >= hi) continue
    let head: CurveKnot
    let tail: CurveKnot
    if (a.s) {
      // Step segment: the boundary knots just hold a's value, no de Casteljau.
      head = { t: Math.max(a.t, lo), v: a.v, s: true }
      tail = b.t > hi ? { t: hi, v: a.v } : { ...b }
    } else if (a.t < lo || b.t > hi) {
      // Boundary segment: split so the clipped piece traces the original.
      let p = segmentCtrl(a, b)
      if (a.t < lo) p = splitCtrl(p, paramAt(p, lo))[1]
      if (b.t > hi) p = splitCtrl(p, paramAt(p, hi))[0]
      ;[head, tail] = ctrlToKnots(p)
    } else {
      head = { ...a }
      tail = { ...b }
    }
    if (out.length === 0) {
      out.push(head)
    } else {
      // Interior knot was already pushed as the previous tail; adopt this
      // segment's outgoing handle and step flag onto it.
      const prev = out[out.length - 1]
      if (head.o) prev.o = head.o
      else delete prev.o
      if (head.s) prev.s = true
      else delete prev.s
    }
    out.push(tail)
  }
  if (out.length < 2) return null
  // Boundary knots keep only their inward handles, and `s` on the last knot
  // means nothing — strip it so the clip is canonical.
  delete out[0].i
  delete out[out.length - 1].o
  delete out[out.length - 1].s
  return out
}

/**
 * Clamp every handle's dt into its segment, scaling dv to keep the handle
 * direction: keeps x(u) monotone after knots move or fitting overshoots.
 * Mutates (handle tuples are replaced, never edited in place). Handles on a
 * step segment are dead: left untouched, never resurrected or scaled.
 */
export function clampHandleTimes(knots: CurveKnot[]): void {
  for (let k = 0; k < knots.length; k++) {
    const kn = knots[k]
    if (kn.o && k + 1 < knots.length && !kn.s) {
      const span = knots[k + 1].t - kn.t
      if (kn.o[0] < 0) kn.o = [0, 0]
      else if (kn.o[0] > span) kn.o = [span, (kn.o[1] * span) / kn.o[0]]
    }
    if (kn.i && k > 0 && !knots[k - 1].s) {
      const span = kn.t - knots[k - 1].t
      if (kn.i[0] > 0) kn.i = [0, 0]
      else if (kn.i[0] < -span) kn.i = [-span, (kn.i[1] * -span) / kn.i[0]]
    }
  }
}

// ---------------------------------------------------------------------------
// Schneider least-squares fit.

const sub = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: XY, b: XY): XY => ({ x: a.x + b.x, y: a.y + b.y })
const scale = (a: XY, s: number): XY => ({ x: a.x * s, y: a.y * s })
const dot = (a: XY, b: XY): number => a.x * b.x + a.y * b.y
const norm = (a: XY): number => Math.hypot(a.x, a.y)
const unit = (a: XY): XY => {
  const n = norm(a)
  return n === 0 ? { x: 0, y: 0 } : scale(a, 1 / n)
}

function chordLengthParameterize(pts: XY[], first: number, last: number): number[] {
  const u = [0]
  for (let i = first + 1; i <= last; i++) {
    u.push(u[i - first - 1] + norm(sub(pts[i], pts[i - 1])))
  }
  const total = u[u.length - 1]
  return u.map((x) => (total === 0 ? 0 : x / total))
}

/** Least-squares cubic through pts[first..last] with the given end tangents. */
function generateBezier(
  pts: XY[],
  first: number,
  last: number,
  uPrime: number[],
  tHat1: XY,
  tHat2: XY
): [XY, XY, XY, XY] {
  const p0 = pts[first]
  const p3 = pts[last]
  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i <= last - first; i++) {
    const u = uPrime[i]
    const w = 1 - u
    const b0 = w * w * w
    const b1 = 3 * u * w * w
    const b2 = 3 * u * u * w
    const b3 = u * u * u
    const a0 = scale(tHat1, b1)
    const a1 = scale(tHat2, b2)
    c00 += dot(a0, a0)
    c01 += dot(a0, a1)
    c11 += dot(a1, a1)
    const tmp = sub(pts[first + i], add(scale(p0, b0 + b1), scale(p3, b2 + b3)))
    x0 += dot(a0, tmp)
    x1 += dot(a1, tmp)
  }
  const detC = c00 * c11 - c01 * c01
  let alphaL = detC === 0 ? 0 : (x0 * c11 - x1 * c01) / detC
  let alphaR = detC === 0 ? 0 : (c00 * x1 - c01 * x0) / detC
  // Degenerate alphas: Wu/Barsky heuristic (a third of the chord).
  const segLength = norm(sub(p3, p0))
  const epsilon = 1e-6 * segLength
  if (alphaL < epsilon || alphaR < epsilon) {
    alphaL = alphaR = segLength / 3
  }
  return [p0, add(p0, scale(tHat1, alphaL)), add(p3, scale(tHat2, alphaR)), p3]
}

/** Max squared distance from the points to the curve, and where it happens. */
function computeMaxError(
  pts: XY[],
  first: number,
  last: number,
  bez: [XY, XY, XY, XY],
  u: number[]
): { maxDist: number; splitPoint: number } {
  let splitPoint = (last - first + 1) >> 1
  let maxDist = 0
  for (let i = first + 1; i < last; i++) {
    const d = sub(bezXY(bez, u[i - first]), pts[i])
    const dist = dot(d, d)
    if (dist >= maxDist) {
      maxDist = dist
      splitPoint = i
    }
  }
  return { maxDist, splitPoint }
}

function newtonRaphsonRootFind(bez: [XY, XY, XY, XY], p: XY, u: number): number {
  // Q'(u) and Q''(u) control points.
  const q1: XY[] = []
  const q2: XY[] = []
  for (let i = 0; i < 3; i++) q1.push(scale(sub(bez[i + 1], bez[i]), 3))
  for (let i = 0; i < 2; i++) q2.push(scale(sub(q1[i + 1], q1[i]), 2))
  const qu = bezXY(bez, u)
  const w = 1 - u
  const q1u = add(add(scale(q1[0], w * w), scale(q1[1], 2 * w * u)), scale(q1[2], u * u))
  const q2u = add(scale(q2[0], w), scale(q2[1], u))
  const num = dot(sub(qu, p), q1u)
  const den = dot(q1u, q1u) + dot(sub(qu, p), q2u)
  return den === 0 ? u : u - num / den
}

function fitCubicRec(
  pts: XY[],
  first: number,
  last: number,
  tHat1: XY,
  tHat2: XY,
  error: number,
  out: [XY, XY, XY, XY][]
): void {
  // Two points: heuristic straight-ish cubic.
  if (last - first + 1 === 2) {
    const dist = norm(sub(pts[last], pts[first])) / 3
    out.push([
      pts[first],
      add(pts[first], scale(tHat1, dist)),
      add(pts[last], scale(tHat2, dist)),
      pts[last]
    ])
    return
  }
  let u = chordLengthParameterize(pts, first, last)
  let bez = generateBezier(pts, first, last, u, tHat1, tHat2)
  let { maxDist, splitPoint } = computeMaxError(pts, first, last, bez, u)
  if (maxDist < error) {
    out.push(bez)
    return
  }
  // A few Newton-Raphson reparameterization rounds before giving up on a
  // single segment: chord-length u is only a first guess.
  for (let it = 0; it < 4; it++) {
    u = u.map((uu, i) => newtonRaphsonRootFind(bez, pts[first + i], uu))
    bez = generateBezier(pts, first, last, u, tHat1, tHat2)
    ;({ maxDist, splitPoint } = computeMaxError(pts, first, last, bez, u))
    if (maxDist < error) {
      out.push(bez)
      return
    }
  }
  // Split at the worst point and recurse with a shared center tangent.
  const tHatCenter = unit(sub(pts[splitPoint - 1], pts[splitPoint + 1]))
  fitCubicRec(pts, first, splitPoint, tHat1, tHatCenter, error, out)
  fitCubicRec(pts, splitPoint, last, scale(tHatCenter, -1), tHat2, error, out)
}

/**
 * Fit a piecewise cubic bezier to time-sorted (t, v) samples. `maxError` is
 * a distance in normalized space (t scaled by the time span, v by the value
 * range), so tolerance is scale-independent. Duplicate times keep the last
 * sample (OSC last-wins). Returns null for fewer than 2 distinct samples.
 */
export function fitCurve(points: { t: number; v: number }[], maxError: number): CurveKnot[] | null {
  const dedup: { t: number; v: number }[] = []
  for (const p of points) {
    if (dedup.length > 0 && p.t === dedup[dedup.length - 1].t) dedup[dedup.length - 1] = p
    else dedup.push(p)
  }
  if (dedup.length < 2) return null
  const t0 = dedup[0].t
  const tSpan = dedup[dedup.length - 1].t - t0 || 1
  let vMin = Infinity
  let vMax = -Infinity
  for (const p of dedup) {
    vMin = Math.min(vMin, p.v)
    vMax = Math.max(vMax, p.v)
  }
  const vSpan = vMax - vMin || 1
  const pts: XY[] = dedup.map((p) => ({ x: (p.t - t0) / tSpan, y: (p.v - vMin) / vSpan }))

  const segs: [XY, XY, XY, XY][] = []
  const tHat1 = unit(sub(pts[1], pts[0]))
  const tHat2 = unit(sub(pts[pts.length - 2], pts[pts.length - 1]))
  fitCubicRec(pts, 0, pts.length - 1, tHat1, tHat2, maxError * maxError, segs)

  // Cubics → knots (denormalized). Segments share endpoints by construction.
  const deN = (p: XY): { t: number; v: number } => ({ t: t0 + p.x * tSpan, v: vMin + p.y * vSpan })
  const knots: CurveKnot[] = []
  for (let s = 0; s < segs.length; s++) {
    const [p0, p1, p2, p3] = segs[s]
    const k0 = deN(p0)
    const k3 = deN(p3)
    const h1 = deN(p1)
    const h2 = deN(p2)
    if (s === 0) knots.push({ t: k0.t, v: k0.v })
    const left = knots[knots.length - 1]
    left.o = [h1.t - k0.t, h1.v - k0.v]
    knots.push({ t: k3.t, v: k3.v, i: [h2.t - k3.t, h2.v - k3.v] })
  }
  // Monotone time: fitted tangents can overshoot horizontally.
  clampHandleTimes(knots)
  delete knots[0].i
  delete knots[knots.length - 1].o
  return knots
}
