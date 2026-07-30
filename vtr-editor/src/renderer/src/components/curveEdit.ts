/** Pure knot-edit ops for the curve editor: move knots and set handles while
 *  keeping knot times strictly increasing and handle dt inside its segment.
 *  No DOM so it unit-tests with vitest; CurvePanel converts pointer deltas
 *  into clip-local (t, v) and calls these. */
import { clampHandleTimes } from '../../../shared/curve'
import type { CurveKnot } from '../../../shared/types'

/** Min time gap kept between knots when a drag would collide them. */
export const KNOT_GAP = 1e-6

/**
 * Move a subset of knots to new (t, v). Group moves (translate/scale) keep
 * their internal order, so only moved-vs-unmoved collisions need care: a
 * ceiling pass bounds each moved knot by its right neighbor, then a floor
 * pass by its left neighbor (the floor wins when there is no room). Unmoved
 * knots never shift. Handles re-clamp to the new segment spans.
 */
export function applyKnotMoves(
  knots: CurveKnot[],
  moves: Map<number, { t: number; v: number }>
): CurveKnot[] {
  const out = knots.map((k, i) => {
    const m = moves.get(i)
    return m ? { ...k, t: m.t, v: m.v } : { ...k }
  })
  for (let i = out.length - 1; i >= 0; i--) {
    if (!moves.has(i)) continue
    const hi = i + 1 < out.length ? out[i + 1].t - KNOT_GAP : Infinity
    if (out[i].t > hi) out[i].t = hi
  }
  for (let i = 0; i < out.length; i++) {
    if (!moves.has(i)) continue
    const lo = i > 0 ? out[i - 1].t + KNOT_GAP : -Infinity
    if (out[i].t < lo) out[i].t = lo
  }
  clampHandleTimes(out)
  return out
}

/**
 * Set one handle to the offset (dt, dv), dt clamped into its segment
 * (o: [0, next span]; i: [-prev span, 0]). A handle with no neighbor on its
 * side does not exist; the knots come back unchanged.
 */
export function setKnotHandle(
  knots: CurveKnot[],
  index: number,
  side: 'i' | 'o',
  dt: number,
  dv: number
): CurveKnot[] {
  const out = knots.map((k) => ({ ...k }))
  const k = out[index]
  if (!k) return out
  if (side === 'o') {
    if (index + 1 >= out.length) return out
    const span = out[index + 1].t - k.t
    k.o = [Math.min(Math.max(dt, 0), span), dv]
  } else {
    if (index === 0) return out
    const span = k.t - out[index - 1].t
    k.i = [Math.min(Math.max(dt, -span), 0), dv]
  }
  return out
}
