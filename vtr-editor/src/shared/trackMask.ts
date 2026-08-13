/** Track priority: the lower track wins (see docs/tasks/track-priority).
 *
 *  For one (port, address) key, a clip masks that key's window on every
 *  track above it: upper events inside the window are dropped, upper curves
 *  are carved, and the upper track resumes its own value at the window's
 *  end. Pure and type-agnostic: both consumers (merge.ts, buildProperties)
 *  feed the same abstract shapes, so this module never sees ClipInst or
 *  ProjectClip.
 *
 *  Times are seconds. `clipKeys` works in clip-local time (trim window),
 *  everything else in timeline time.
 */
import { clipCurve, clampHandleTimes, evalCurve, unshadowedPoints } from './curve'
import type { ClipCurve, ClipEdits, CurveKnot, OscEvent } from './types'

/** Export time grid: microseconds. Boundary margins are one step of it, so
 *  rounding can never collapse a margin back onto its boundary. */
export const EPS = 1e-6

export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

/** Mask identity. Port is part of it: two controllers on two ports collide
 *  on address strings. */
export function maskKey(port: number, a: string): string {
  return `${port} ${a}`
}

export interface Interval {
  start: number
  end: number
}

/** One clip's timeline window plus the keys it carries. Callers pass only
 *  unmuted clips — muted clips don't mask (they keep their timeline slot,
 *  which is the caller's business). */
export interface MaskClip extends Interval {
  keys: ReadonlySet<string>
}

/** Per key, the merged windows that mask a track. */
export type MaskIntervals = Map<string, Interval[]>

/** A clip overlay's curves minus the deleted ones. */
export function liveCurves(clipEdits?: ClipEdits): ClipCurve[] {
  return clipEdits?.curves?.filter((_, i) => !clipEdits.curveDel?.[i]) ?? []
}

/**
 * The keys a clip carries inside its trim: at least one event in the window,
 * or a curve that overlaps it. `events` must already be edited (applyEdits) —
 * a t edit decides whether an event falls inside the trim, same order merge
 * uses. Clip-local times.
 */
export function clipKeys(
  events: readonly OscEvent[],
  clipEdits: ClipEdits | undefined,
  trimIn: number,
  trimOut: number
): Set<string> {
  const keys = new Set<string>()
  for (const e of events) {
    if (e.t < trimIn || e.t > trimOut) continue
    keys.add(maskKey(e.port, e.a))
  }
  for (const c of liveCurves(clipEdits)) {
    // Same overlap test as clipCurve: a curve that only touches the trim
    // boundary places nothing, so it carries nothing.
    const lo = Math.max(trimIn, c.knots[0].t)
    const hi = Math.min(trimOut, c.knots[c.knots.length - 1].t)
    if (hi - lo > 1e-9) keys.add(maskKey(c.port, c.a))
  }
  return keys
}

/** Sort by start and merge overlapping or touching intervals. */
function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const iv of sorted) {
    const prev = out[out.length - 1]
    if (prev && iv.start <= prev.end) prev.end = Math.max(prev.end, iv.end)
    else out.push({ ...iv })
  }
  return out
}

/**
 * Per track index, the windows masking it: the union of every *lower*
 * track's clip windows per key. `tracks` is top-to-bottom (index 0 = top),
 * so the last track is never masked. Clips on one track never mask each
 * other.
 */
export function maskIntervals(tracks: readonly (readonly MaskClip[])[]): MaskIntervals[] {
  const out: MaskIntervals[] = []
  const below = new Map<string, Interval[]>()
  for (let i = tracks.length - 1; i >= 0; i--) {
    const merged: MaskIntervals = new Map()
    for (const [key, list] of below) merged.set(key, mergeIntervals(list))
    out[i] = merged
    for (const clip of tracks[i]) {
      for (const key of clip.keys) {
        let list = below.get(key)
        if (!list) below.set(key, (list = []))
        list.push({ start: clip.start, end: clip.end })
      }
    }
  }
  return out
}

/** Whether t falls in a mask window for this key, ends inclusive. */
export function maskedAt(intervals: MaskIntervals, key: string, t: number): boolean {
  const list = intervals.get(key)
  return list != null && list.some((iv) => iv.start <= t && t <= iv.end)
}

/**
 * Drop the events a lower track masks. Ends are inclusive: an event exactly
 * on a boundary belongs to the lower track (the resume event re-asserts the
 * upper value just after the end).
 */
export function dropMasked<E extends { t: number; port: number; a: string }>(
  events: readonly E[],
  intervals: MaskIntervals
): E[] {
  if (intervals.size === 0) return [...events]
  return events.filter((e) => !maskedAt(intervals, maskKey(e.port, e.a), e.t))
}

/** Put carved knots back on the export grid, mirroring merge's placeCurve:
 *  rounding can land a split sliver on its neighbor's grid point, and the
 *  player drops a curve whose knots aren't increasing. */
function snap(knots: CurveKnot[]): CurveKnot[] | null {
  const out: CurveKnot[] = []
  for (const k of knots) {
    const placed = { ...k, t: round6(k.t) }
    const prev = out[out.length - 1]
    if (prev && placed.t <= prev.t) out[out.length - 1] = placed
    else out.push(placed)
  }
  if (out.length < 2) return null
  delete out[0].i
  delete out[out.length - 1].o
  delete out[out.length - 1].s
  clampHandleTimes(out)
  return out
}

/**
 * The live pieces of a curve after masking: clipCurve over the complement of
 * `intervals` (sorted and merged, as maskIntervals returns them).
 *
 * Pieces stay one grid step off the boundary — a piece ending exactly at a
 * mask start would shadow the lower track's boundary event forever (the
 * resolver pins a point at a span end, ends inclusive), and a piece starting
 * exactly at a mask end would shadow the lower track's last event. Degenerate
 * pieces (fewer than 2 knots) drop.
 */
export function carveKnots(knots: CurveKnot[], intervals: readonly Interval[]): CurveKnot[][] {
  if (knots.length < 2) return []
  const spanEnd = knots[knots.length - 1].t
  const out: CurveKnot[][] = []
  let lo = knots[0].t
  for (const iv of intervals) {
    if (iv.start > spanEnd) break
    const piece = clipCurve(knots, lo, round6(iv.start - EPS))
    const snapped = piece && snap(piece)
    if (snapped) out.push(snapped)
    lo = Math.max(lo, round6(iv.end + EPS))
  }
  const tail = clipCurve(knots, lo, spanEnd)
  const snapped = tail && snap(tail)
  if (snapped) out.push(snapped)
  return out
}

/**
 * One masked track's material for a single (port, address) key, in timeline
 * space. Events must be edited and placed; curves are the *uncarved* ones,
 * `pieces` the spans left after carveKnots.
 */
export interface TrackMaterial {
  /** In merge order (ties resolve to the later entry, as replay does). */
  events: readonly OscEvent[]
  curves: readonly ClipCurve[]
  /** Live curve spans after carving: one covering the resume time resumes by
   *  itself. */
  pieces: readonly Interval[]
  /** The track's clip windows. A resume only fires inside one. */
  windows: readonly Interval[]
}

/**
 * A masked track's resolved message at a mask end: the whole args list it
 * would emit, plus the arg indices the track actually *defines* there. The
 * rest are template filler nobody may splice over.
 */
export interface ResolvedArgs {
  port: number
  a: string
  args: unknown[]
  /** Same length as `args` when present (never sparse, never mismatched). */
  types?: string
  defined: ReadonlySet<number>
}

/**
 * The masked track's own resolved value at `end`: last definition wins, over
 * the track's own events *and* its curves, with the resolver's rule that a
 * curve's definition time is min(t, span end) and ties go to the curve. A
 * curve controls one arg while an event carries the whole message, so the
 * winning event's args are the template and every curve that outranks it
 * splices its value in at its own arg index (later curves last, so the latest
 * wins per arg). With no event at all the latest curve's own args template
 * stands in. Null when the track has no definition at or before `end`.
 */
export function resolveArgsAt(material: TrackMaterial, end: number): ResolvedArgs | null {
  const spans = material.curves.map((c) => ({
    start: c.knots[0].t,
    end: c.knots[c.knots.length - 1].t
  }))
  // Events inside a span never play, so they can't be the resolved value.
  const live = unshadowedPoints(
    material.events.filter((e) => e.t <= end),
    spans
  )
  let base: OscEvent | null = null
  for (const e of live) if (!base || e.t >= base.t) base = e

  const defs = material.curves
    .map((c, i) => ({ c, def: Math.min(end, spans[i].end), start: spans[i].start }))
    .filter((d) => d.start <= end && d.def >= (base?.t ?? -Infinity))
    .sort((a, b) => a.def - b.def)
  if (!base && defs.length === 0) return null

  const src = base ?? defs[defs.length - 1].c
  const args = [...src.args]
  // Type tags, index-aligned with args while it grows.
  const tags = [...(src.types ?? '')]
  const defined = new Set<number>(base ? args.map((_, i) => i) : [])
  for (const d of defs) {
    // A curve past the template's arity extends it from the curve's own args
    // (a ClipCurve carries the whole message), so args never grows a hole and
    // never outruns types.
    for (let i = args.length; i <= d.c.arg; i++) {
      args[i] = d.c.args[i] ?? 0
      tags[i] = d.c.types?.[i] ?? 'f'
    }
    args[d.c.arg] = evalCurve(d.c.knots, end)
    defined.add(d.c.arg)
  }
  return { port: src.port, a: src.a, args, types: joinTags(src.types, tags, args.length), defined }
}

/** Type tag string of `n` args, or undefined when the source carried none. */
function joinTags(src: string | undefined, tags: readonly string[], n: number): string | undefined {
  if (src === undefined) return undefined
  let out = ''
  for (let i = 0; i < n; i++) out += tags[i] ?? 'f'
  return out
}

/**
 * The event that resumes a masked track at a mask window's end: its own
 * resolved value at `end`, emitted one grid step later so it sorts after the
 * lower track's boundary event (a tie would let the stale side win).
 *
 * Null when
 *  - a carved curve piece covers that time — the piece resumes exactly by
 *    itself, and an event inside a span never plays anyway;
 *  - a real event of the track already sits on that grid point — it
 *    re-asserts the value itself, and a stale resume would override it;
 *  - no clip window of this track contains `end` — punch-out past the clip's
 *    own end resumes nothing;
 *  - the track has no definition at or before `end`.
 */
export function resumeEvent(material: TrackMaterial, end: number): OscEvent | null {
  const t = round6(end + EPS)
  if (!material.windows.some((w) => w.start <= end && end <= w.end)) return null
  if (material.pieces.some((p) => p.start <= t && t <= p.end)) return null
  if (material.events.some((e) => e.t === t)) return null

  const r = resolveArgsAt(material, end)
  return r && { t, port: r.port, a: r.a, args: r.args, types: r.types }
}

/**
 * Splice a masked track's resolved values into a live curve piece's emission
 * template. Suppression of the resume is per (port, address), but a piece
 * only re-asserts its own arg (`held` = the args live pieces cover), so every
 * other arg the track defines would keep emitting the piece's stale template
 * value. The player takes a curve group's template from its first member and
 * emits template values verbatim for args with no member, so callers patch
 * *every* covering piece — grouping order then can't matter.
 */
export function patchArgs(
  curve: ClipCurve,
  resolved: ResolvedArgs,
  held: ReadonlySet<number>
): ClipCurve {
  const args = [...curve.args]
  const tags = [...(curve.types ?? '')]
  let changed = false
  for (let i = 0; i < resolved.args.length; i++) {
    if (held.has(i) || !resolved.defined.has(i)) continue
    // Same arity rule as resolveArgsAt: fill the gap rather than leave a hole.
    for (let j = args.length; j <= i; j++) {
      args[j] = resolved.args[j]
      tags[j] = resolved.types?.[j] ?? 'f'
    }
    args[i] = resolved.args[i]
    changed = true
  }
  if (!changed) return curve
  const types = joinTags(curve.types, tags, args.length)
  return types === undefined ? { ...curve, args } : { ...curve, args, types }
}
