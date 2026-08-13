/** Interpolation modes of the curve header: derive the mode of a selected
 *  point and apply a picked one to a curve's knots. Modes are always derived
 *  from the data, never stored. Pure (no DOM) so it unit-tests with vitest;
 *  CurvePanel shows what these derive and App.tsx commits what they build. */
import type { CurvePatch, KnotSel, PointSel } from '../../../shared/edits'
import type { ClipEdits, CurveKnot } from '../../../shared/types'

/** `const` is a discrete event point or a knot whose outgoing segment steps;
 *  the ease modes name the handles a knot carries on its live sides. */
export type InterpMode = 'const' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

/** Dropdown order. */
export const MODES: InterpMode[] = ['const', 'linear', 'ease-in', 'ease-out', 'ease-in-out']

export const MODE_LABELS: Record<InterpMode, string> = {
  const: 'const',
  linear: 'linear',
  'ease-in': 'ease in',
  'ease-out': 'ease out',
  'ease-in-out': 'ease in out'
}

/** The knot array a KnotSel points at, or null when it no longer resolves —
 *  a selection outlives its curve/knot across an undo. */
function knotsOf(edits: Record<string, ClipEdits>, sel: KnotSel): CurveKnot[] | null {
  const clipEdits = edits[sel.file]
  if (!clipEdits || clipEdits.curveDel?.[sel.curveIndex]) return null
  const curve = clipEdits.curves?.[sel.curveIndex]
  if (!curve || sel.knotIndex < 0 || sel.knotIndex >= curve.knots.length) return null
  return curve.knots
}

/** Mode of one selected point; null when the selection is stale. */
export function deriveMode(sel: PointSel, edits: Record<string, ClipEdits>): InterpMode | null {
  if (!('curveIndex' in sel)) return 'const'
  const knots = knotsOf(edits, sel)
  if (!knots) return null
  const i = sel.knotIndex
  const k = knots[i]
  const hasNext = i + 1 < knots.length
  // `s` on the last knot means nothing (flat extension already holds).
  if (hasNext && k.s) return 'const'
  // A side with no segment doesn't count, and neither does one across a step
  // segment — its handles are dead.
  const hasIn = i > 0 && !knots[i - 1].s && !!k.i
  const hasOut = hasNext && !!k.o
  if (hasIn && hasOut) return 'ease-in-out'
  if (hasIn) return 'ease-in'
  if (hasOut) return 'ease-out'
  return 'linear'
}

/** Every mode a knot is consistent with. A knot shows its most specific one
 *  (deriveMode), but an endpoint is consistent with more than that: its dead
 *  side demands nothing, so a first knot with an `o` handle is both ease out
 *  and ease in out. That's what makes "ease in out on the whole curve" read
 *  back as one mode instead of three. */
function modeCandidates(sel: PointSel, edits: Record<string, ClipEdits>): Set<InterpMode> | null {
  if (!('curveIndex' in sel)) return new Set(['const'])
  const knots = knotsOf(edits, sel)
  if (!knots) return null
  const i = sel.knotIndex
  const k = knots[i]
  const hasNext = i + 1 < knots.length
  const out = new Set<InterpMode>()
  // Nothing follows the last knot to hold, so const fits it either way.
  if (!hasNext || k.s) out.add('const')
  if (hasNext && k.s) return out
  const inLive = i > 0 && !knots[i - 1].s
  for (const m of MODES) {
    if (m === 'const') continue
    if (inLive && !!k.i !== (m === 'ease-in' || m === 'ease-in-out')) continue
    if (hasNext && !!k.o !== (m === 'ease-out' || m === 'ease-in-out')) continue
    out.add(m)
  }
  return out
}

/** The mode the whole selection reads as; null when they genuinely differ,
 *  the selection is empty, or nothing in it still resolves. Points that
 *  derive the same mode settle it; otherwise the one mode they are all
 *  consistent with does. */
export function selectionMode(
  sels: PointSel[],
  edits: Record<string, ClipEdits>
): InterpMode | null {
  let mode: InterpMode | null = null
  let agree = true
  for (const sel of sels) {
    const m = deriveMode(sel, edits)
    if (m == null) continue
    if (mode == null) mode = m
    else if (mode !== m) agree = false
  }
  if (agree || mode == null) return mode
  let shared: Set<InterpMode> | null = null
  for (const sel of sels) {
    const c = modeCandidates(sel, edits)
    if (!c) continue
    if (!shared) {
      shared = c
      continue
    }
    for (const m of [...shared]) {
      if (!c.has(m)) shared.delete(m)
    }
  }
  return shared && shared.size === 1 ? [...shared][0] : null
}

/**
 * Apply one mode to a set of knots of a single curve. Two passes, so a
 * selection spanning neighbors settles its step flags before the handles
 * read them. Idempotent: a required handle already there is kept (a dragged
 * handle survives re-picking its mode, and ease in → ease in out only adds
 * the missing side), a forbidden one is deleted, sides without a segment are
 * skipped.
 */
export function applyMode(
  knots: CurveKnot[],
  indices: Iterable<number>,
  mode: InterpMode
): CurveKnot[] {
  const idx = [...indices].filter((i) => i >= 0 && i < knots.length)
  const out = knots.map((k) => ({ ...k }))
  for (const i of idx) {
    if (mode === 'const') {
      // Nothing follows the last knot to hold against. The step segment's
      // dead handles go; `i` belongs to the incoming segment and stays.
      if (i + 1 >= out.length) continue
      out[i].s = true
      delete out[i].o
      delete out[i + 1].i
    } else {
      // Both adjacent segments interpolate again — the previous knot stops
      // reading as const too.
      delete out[i].s
      if (i > 0) delete out[i - 1].s
    }
  }
  if (mode === 'const') return out
  const wantIn = mode === 'ease-in' || mode === 'ease-in-out'
  const wantOut = mode === 'ease-out' || mode === 'ease-in-out'
  for (const i of idx) {
    if (i > 0) {
      if (wantIn) out[i].i ??= [-(out[i].t - out[i - 1].t) / 3, 0]
      else delete out[i].i
    }
    if (i + 1 < out.length) {
      if (wantOut) out[i].o ??= [(out[i + 1].t - out[i].t) / 3, 0]
      else delete out[i].o
    }
  }
  return out
}

const sameHandle = (a?: [number, number], b?: [number, number]): boolean =>
  a == null ? b == null : b != null && a[0] === b[0] && a[1] === b[1]

/** Structural compare, so re-picking a knot's current mode commits nothing
 *  (the arrays are always fresh; only their content decides). */
function sameKnots(a: CurveKnot[], b: CurveKnot[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (k, i) =>
        k.t === b[i].t &&
        k.v === b[i].v &&
        k.s === b[i].s &&
        sameHandle(k.i, b[i].i) &&
        sameHandle(k.o, b[i].o)
    )
  )
}

/** Mode changes for the knots in a selection: one whole-array patch per
 *  curve (per-knot patches would overwrite each other — same rule as
 *  movePatches in useCurveInteraction). Stale selections and no-op changes
 *  drop out; event points are the caller's business (they convert). */
export function modePatches(
  sels: PointSel[],
  edits: Record<string, ClipEdits>,
  mode: InterpMode
): CurvePatch[] {
  const byCurve = new Map<string, { sel: KnotSel; knots: CurveKnot[]; idx: number[] }>()
  for (const sel of sels) {
    if (!('curveIndex' in sel)) continue
    const knots = knotsOf(edits, sel)
    if (!knots) continue
    const key = `${sel.file}:${sel.curveIndex}`
    let g = byCurve.get(key)
    if (!g) byCurve.set(key, (g = { sel, knots, idx: [] }))
    g.idx.push(sel.knotIndex)
  }
  const out: CurvePatch[] = []
  for (const { sel, knots, idx } of byCurve.values()) {
    const next = applyMode(knots, idx, mode)
    if (sameKnots(knots, next)) continue
    out.push({ file: sel.file, curveIndex: sel.curveIndex, knots: next })
  }
  return out
}
