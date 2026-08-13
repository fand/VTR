import { clipCurve } from './curve'
import type { ClipCurve, ClipEdits, CurveKnot, OscEvent } from './types'

export function editsEmpty(edits?: ClipEdits): boolean {
  return (
    !edits ||
    ((!edits.set || Object.keys(edits.set).length === 0) &&
      (!edits.del || Object.keys(edits.del).length === 0) &&
      (!edits.add || edits.add.length === 0) &&
      (!edits.curves || edits.curves.length === 0))
  )
}

/** An edited event paired with its index in the original clip file. */
export interface IndexedEvent {
  ev: OscEvent
  idx: number
}

/**
 * Apply an edit overlay to a clip's original events, keeping each event's
 * original index (the key space of ClipEdits). Re-sorted by t.
 */
export function applyEditsIndexed(events: OscEvent[], edits?: ClipEdits): IndexedEvent[] {
  const out: IndexedEvent[] = []
  // Added events take the keys past the original count (add is append-only),
  // so set/del apply to them the same way.
  const all = edits?.add && edits.add.length > 0 ? [...events, ...edits.add] : events
  for (let i = 0; i < all.length; i++) {
    if (edits?.del?.[i]) continue
    const patch = edits?.set?.[i]
    if (!patch) {
      out.push({ ev: all[i], idx: i })
      continue
    }
    const e = { ...all[i] }
    if (patch.t != null) e.t = patch.t
    if (patch.args) {
      const args = [...e.args]
      for (const [idx, v] of Object.entries(patch.args)) args[Number(idx)] = v
      e.args = args
    }
    out.push({ ev: e, idx: i })
  }
  out.sort((a, b) => a.ev.t - b.ev.t)
  return out
}

/** Same, without the index bookkeeping (export/preview path). */
export function applyEdits(events: OscEvent[], edits?: ClipEdits): OscEvent[] {
  if (editsEmpty(edits)) return events
  return applyEditsIndexed(events, edits).map((x) => x.ev)
}

// ---------------------------------------------------------------------------
// Overlay transforms. The curve panel drives these against the document's
// edits record (mutating, inside an undo commit/transient); they own the
// overlay invariants, so they live here rather than in the renderer.

/** One numeric-arg edit: absolute clip-local t and/or value for args[argIndex]. */
export interface EventPatch {
  file: string
  eventIndex: number
  t?: number
  argIndex?: number
  value?: number
}

/** Whole-array knot replacement for one overlay curve (clip-local t). */
export interface CurvePatch {
  file: string
  curveIndex: number
  knots: CurveKnot[]
}

export type PointPatch = EventPatch | CurvePatch

/** One selected discrete point (an event's numeric arg). */
export interface EventPointSel {
  /** Clip file the event belongs to (ClipEdits key space). */
  file: string
  eventIndex: number
  argIndex: number
}

/** One selected bezier knot; curveIndex keys the overlay's curves array. */
export interface KnotSel {
  file: string
  curveIndex: number
  knotIndex: number
}

export type PointSel = EventPointSel | KnotSel

/** Apply drag/edit patches onto the overlay. */
export function applyPointPatches(edits: Record<string, ClipEdits>, patches: PointPatch[]): void {
  for (const patch of patches) {
    const clipEdits = (edits[patch.file] ??= {})
    if ('curveIndex' in patch) {
      // Whole-array knot replacement; a vanished curve (undone mid-drag)
      // is skipped rather than resurrected.
      const curve = clipEdits.curves?.[patch.curveIndex]
      if (curve) curve.knots = patch.knots
      continue
    }
    const set = (clipEdits.set ??= {})
    const entry = (set[patch.eventIndex] ??= {})
    if (patch.t != null) entry.t = patch.t
    if (patch.argIndex != null && patch.value != null) {
      ;(entry.args ??= {})[patch.argIndex] = patch.value
    }
  }
}

/** Append new points to their clips' edit overlays (add is append-only). */
export function addPoints(
  edits: Record<string, ClipEdits>,
  adds: { file: string; ev: OscEvent }[]
): void {
  for (const { file, ev } of adds) {
    ;((edits[file] ??= {}).add ??= []).push(ev)
  }
}

/**
 * Replace covered events with fitted curves: delete the events and append
 * the curves. A new curve carves its span out of same-(port, a, arg) curves
 * already in the overlay, so re-replacing a range never leaves two curves
 * competing for it.
 */
export function replaceWithCurves(
  edits: Record<string, ClipEdits>,
  dels: { file: string; eventIndex: number }[],
  adds: { file: string; curve: ClipCurve }[]
): void {
  for (const { file, eventIndex } of dels) {
    const clipEdits = (edits[file] ??= {})
    ;(clipEdits.del ??= {})[eventIndex] = true
  }
  for (const { file, curve } of adds) {
    const clipEdits = (edits[file] ??= {})
    const curves = (clipEdits.curves ??= [])
    const visible = curves.map((c, i) => (clipEdits.curveDel?.[i] ? undefined : c))
    const cut = subtractCurveOverlap(visible, curve)
    for (const i of cut.dels) (clipEdits.curveDel ??= {})[i] = true
    curves.push(...cut.remainders, curve)
  }
}

/**
 * Delete the selected points and knots. Knot deletes group per curve: the
 * knots come out in one pass, and a curve left with fewer than 2 knots is
 * dropped entirely (curveDel).
 */
export function deletePoints(edits: Record<string, ClipEdits>, sels: PointSel[]): void {
  const knotDels = new Map<string, { file: string; curveIndex: number; idx: Set<number> }>()
  for (const pt of sels) {
    if ('curveIndex' in pt) {
      const key = `${pt.file}:${pt.curveIndex}`
      let g = knotDels.get(key)
      if (!g) knotDels.set(key, (g = { file: pt.file, curveIndex: pt.curveIndex, idx: new Set() }))
      g.idx.add(pt.knotIndex)
      continue
    }
    const clipEdits = (edits[pt.file] ??= {})
    ;(clipEdits.del ??= {})[pt.eventIndex] = true
  }
  for (const { file, curveIndex, idx } of knotDels.values()) {
    const clipEdits = edits[file]
    const curve = clipEdits?.curves?.[curveIndex]
    if (!curve || clipEdits.curveDel?.[curveIndex]) continue
    const keep = curve.knots.filter((_, i) => !idx.has(i))
    if (keep.length < 2) {
      ;(clipEdits.curveDel ??= {})[curveIndex] = true
    } else {
      // New boundary knots keep only their inward handles, and a new last
      // knot's step flag is moot (nothing follows it to hold against).
      const knots = keep.map((k) => ({ ...k }))
      delete knots[0].i
      delete knots[knots.length - 1].o
      delete knots[knots.length - 1].s
      curve.knots = knots
    }
  }
}

/**
 * Carve `added`'s span out of the overlay curves that share its
 * (port, a, arg): overlapping curves are deleted and their out-of-span
 * remainders re-appended, so one clip never holds two curves competing for
 * the same time range. `existing` is the overlay's curves array with
 * already-deleted entries as undefined (indices are curveDel keys).
 */
export function subtractCurveOverlap(
  existing: (ClipCurve | undefined)[],
  added: ClipCurve
): { dels: number[]; remainders: ClipCurve[] } {
  const t0 = added.knots[0].t
  const t1 = added.knots[added.knots.length - 1].t
  const dels: number[] = []
  const remainders: ClipCurve[] = []
  existing.forEach((c, i) => {
    if (!c || c.port !== added.port || c.a !== added.a || c.arg !== added.arg) return
    const start = c.knots[0].t
    const end = c.knots[c.knots.length - 1].t
    if (end <= t0 || start >= t1) return
    dels.push(i)
    const left = clipCurve(c.knots, -Infinity, t0)
    if (left) remainders.push({ ...c, knots: left })
    const right = clipCurve(c.knots, t1, Infinity)
    if (right) remainders.push({ ...c, knots: right })
  })
  return { dels, remainders }
}
