/** Pure data layer of the curve panel: property building from clip events +
 *  edit overlays, selection identities, patch types, and the one traversal
 *  over everything drawn (points + knots). No React, no DOM. */
import { clipCurve, unshadowedPoints } from '../../../shared/curve'
import { applyEditsIndexed } from '../../../shared/edits'
import type { EventPointSel, KnotSel, PointSel } from '../../../shared/edits'
import { carveKnots, maskKey, maskedAt } from '../../../shared/trackMask'
import type { Interval, MaskIntervals } from '../../../shared/trackMask'
import type { ClipCurve, ClipEdits, CurveKnot, OscEvent } from '../../../shared/types'
import { MAX_PX_PER_SEC, type ClipInst } from '../timeline/model'
import type { GeomEl } from './curveGeom'

/** Distinct color per property: golden-angle hues stay spread out at any
 *  count; lightness cycles so neighboring hues still read apart. */
export function propColor(i: number): string {
  const hue = (210 + i * 137.508) % 360
  const light = [65, 55, 75][i % 3]
  return `hsl(${hue.toFixed(1)}, 75%, ${light}%)`
}

/** Short number for the hover tooltip: ≤3 decimals, no trailing zeros. */
export function fmt(n: number): string {
  return String(Number(n.toFixed(3)))
}

export const MAX_ZOOM = 50

/** X-zoom ceiling: at least MAX_ZOOM, deeper for long time ranges so max zoom
 *  always reaches the timeline's frame-level px/s scale. */
export function maxZoomX(w: number, tRange: number): number {
  return Math.max(MAX_ZOOM, (tRange * MAX_PX_PER_SEC) / Math.max(w, 1))
}

export interface CurvePoint {
  /** Timeline seconds (clip offset applied). */
  t: number
  v: number
  /** Event index in the original clip file (ClipEdits key). */
  eventIndex: number
  argIndex: number
  /** The clip instance this point came from (drives clamping + patches). */
  clip: ClipInst
  /** The edited event itself (template for added points). */
  ev: OscEvent
  /** A lower track owns this (port, address) here, so the point never plays.
   *  Drawn dimmed, still selectable and editable. */
  masked: boolean
}

/** One overlay curve drawn on a property: timeline-space knots, already
 *  trim-clipped to its clip. */
export interface PropCurve {
  clip: ClipInst
  /** Index into the clip overlay's curves array (ClipEdits key space). */
  curveIndex: number
  /** The overlay record itself (clip-local knots; edits rebuild from it). */
  src: ClipCurve
  /** srcIndex maps back into src.knots; -1 marks synthetic boundary knots
   *  from trim clipping (drawn but not editable). The whole list stays here
   *  (selection identities don't move), masked or not. */
  knots: (CurveKnot & { srcIndex: number })[]
  /** Stretches a lower track owns, clipped to this curve's span. Drawn
   *  dimmed/dashed; the live pieces between them make the merged path. */
  maskedRanges: Interval[]
}

/** Which lower-track windows cover each shown clip. Absent = nothing masked. */
export interface MaskCtx {
  /** Per track index (top-to-bottom): the windows lower tracks mask, per key. */
  masks: readonly MaskIntervals[]
  /** Clip id → its track index. */
  trackOf: ReadonlyMap<number, number>
}

const NO_MASK: MaskIntervals = new Map()

export interface Property {
  /** `${addr} ${argIndex}` — stable id, never shown. */
  key: string
  label: string
  color: string
  points: CurvePoint[]
  curves: PropCurve[]
  /** Points + curve spans merged and t-sorted; one drawn path per property. */
  els: GeomEl[]
  min: number
  max: number
}

export function buildProperties(
  clipEvents: { clip: ClipInst; events: OscEvent[] }[],
  edits: Record<string, ClipEdits>,
  mask?: MaskCtx
): Property[] {
  const byKey = new Map<string, CurvePoint[]>()
  const curvesByKey = new Map<string, PropCurve[]>()
  const argCount = new Map<string, number>()
  for (const { clip, events } of clipEvents) {
    // The mask this clip's track carries; a clip with no track entry (tests,
    // stale ids) draws unmasked.
    const intervals = mask?.masks[mask.trackOf.get(clip.id) ?? -1] ?? NO_MASK
    for (const { ev, idx } of applyEditsIndexed(events, edits[clip.file])) {
      if (ev.t < clip.trimIn || ev.t > clip.trimOut) continue
      const t = clip.offset + (ev.t - clip.trimIn)
      const masked = maskedAt(intervals, maskKey(ev.port, ev.a), t)
      ev.args.forEach((arg, argIndex) => {
        if (typeof arg !== 'number') return
        argCount.set(ev.a, Math.max(argCount.get(ev.a) ?? 1, ev.args.length))
        const key = `${ev.a} ${argIndex}`
        let pts = byKey.get(key)
        if (!pts) byKey.set(key, (pts = []))
        pts.push({ t, v: arg, eventIndex: idx, argIndex, clip, ev, masked })
      })
    }
    const clipEdits = edits[clip.file]
    clipEdits?.curves?.forEach((c, ci) => {
      if (clipEdits.curveDel?.[ci]) return
      const clipped = clipCurve(c.knots, clip.trimIn, clip.trimOut)
      if (!clipped) return
      argCount.set(c.a, Math.max(argCount.get(c.a) ?? 1, c.args.length))
      const key = `${c.a} ${c.arg}`
      if (!byKey.has(key)) byKey.set(key, [])
      let list = curvesByKey.get(key)
      if (!list) curvesByKey.set(key, (list = []))
      const knots = clipped.map((k) => ({
        ...k,
        t: clip.offset + (k.t - clip.trimIn),
        // Interior knots are copied verbatim by clipCurve, so an exact
        // t match identifies the source knot; boundary splits get -1.
        srcIndex: c.knots.findIndex((sk) => sk.t === k.t)
      }))
      // Mask windows narrowed to this curve's span; they stay sorted and
      // disjoint, so carveKnots can take them as they are.
      const span = { start: knots[0].t, end: knots[knots.length - 1].t }
      const maskedRanges = (intervals.get(maskKey(c.port, c.a)) ?? [])
        .map((iv) => ({
          start: Math.max(iv.start, span.start),
          end: Math.min(iv.end, span.end)
        }))
        .filter((r) => r.end >= r.start)
      list.push({ clip, curveIndex: ci, src: c, knots, maskedRanges })
    })
  }
  // Sort by address, then arg index, so the list order is stable and scannable.
  const sorted = [...byKey.entries()].sort(([a], [b]) => {
    const [aAddr, aIdx] = a.split(' ')
    const [bAddr, bIdx] = b.split(' ')
    return aAddr === bAddr ? Number(aIdx) - Number(bIdx) : aAddr < bAddr ? -1 : 1
  })
  return sorted.map(([key, points], i) => {
    points.sort((a, b) => a.t - b.t)
    const curves = curvesByKey.get(key) ?? []
    const [addr, argIdx] = key.split(' ')
    const label = (argCount.get(addr) ?? 1) > 1 ? `${addr}[${argIdx}]` : addr
    // Value axis defaults to 0..1; data outside widens it.
    let min = 0
    let max = 1
    for (const p of points) {
      min = Math.min(min, p.v)
      max = Math.max(max, p.v)
    }
    // Control points bound a bezier (convex hull), so knot + handle values
    // are a safe extent for the curve itself.
    for (const pc of curves) {
      for (const k of pc.knots) {
        for (const v of [k.v, k.v + (k.i?.[1] ?? 0), k.v + (k.o?.[1] ?? 0)]) {
          min = Math.min(min, v)
          max = Math.max(max, v)
        }
      }
    }
    // What actually plays: each curve minus its masked stretches (the same
    // carve merge exports), and the points that survive both the masks and
    // those live pieces.
    const live: GeomEl[] = curves.flatMap((pc, ci) =>
      pc.maskedRanges.length === 0
        ? [{ t: pc.knots[0].t, knots: pc.knots, curve: ci }]
        : carveKnots(pc.knots, pc.maskedRanges).map((knots) => ({
            t: knots[0].t,
            knots,
            curve: ci
          }))
    )
    // Points inside a live span never play (the curve outranks them for good —
    // unshadowedPoints), and masked points never play at all, so the merged
    // path skips both; the dots still draw from `points` so they stay visible
    // and editable.
    const spans = live.map((el) => ({
      start: el.t,
      end: 'knots' in el ? el.knots[el.knots.length - 1].t : el.t
    }))
    const els: GeomEl[] = [
      ...unshadowedPoints(
        points.filter((pt) => !pt.masked),
        spans
      ).map((pt) => ({ t: pt.t, v: pt.v })),
      ...live
    ].sort((a, b) => a.t - b.t)
    return { key, label, color: propColor(i), points, curves, els, min, max }
  })
}

// Selection identities and patch types live beside the overlay transforms
// they feed (shared/edits.ts); re-exported here for the panel's modules.
export type {
  CurvePatch,
  EventPatch,
  EventPointSel,
  KnotSel,
  PointPatch,
  PointSel
} from '../../../shared/edits'

export function selKey(s: PointSel): string {
  return 'curveIndex' in s
    ? `${s.file}:c${s.curveIndex}:${s.knotIndex}`
    : `${s.file}:${s.eventIndex}:${s.argIndex}`
}

export function ptSel(pt: CurvePoint): EventPointSel {
  return { file: pt.clip.file, eventIndex: pt.eventIndex, argIndex: pt.argIndex }
}

export function knotSel(pc: PropCurve, srcIndex: number): KnotSel {
  return { file: pc.clip.file, curveIndex: pc.curveIndex, knotIndex: srcIndex }
}

/** One appended point: the overlay event plus its selection identity. */
export interface PointAdd {
  sel: EventPointSel
  ev: OscEvent
}

/** One visited drawn element: a discrete point or a curve knot. */
export interface ElVisit {
  p: Property
  t: number
  v: number
  /** Selection identity; null for synthetic trim-boundary knots. */
  sel: PointSel | null
  /** Set for discrete points. */
  pt?: CurvePoint
  /** Set for knots, with srcIndex (-1 = synthetic boundary). */
  pc?: PropCurve
  srcIndex?: number
}

/** Visit every drawn element of each property: its points, then each
 *  curve's knots (synthetic boundary knots included, with sel: null).
 *  Callers filter — the properties passed in decide hidden/dimmed scope. */
export function forEachEl(props: Iterable<Property>, cb: (el: ElVisit) => void): void {
  for (const p of props) {
    for (const pt of p.points) cb({ p, t: pt.t, v: pt.v, sel: ptSel(pt), pt })
    for (const pc of p.curves) {
      for (const k of pc.knots) {
        cb({
          p,
          t: k.t,
          v: k.v,
          sel: k.srcIndex >= 0 ? knotSel(pc, k.srcIndex) : null,
          pc,
          srcIndex: k.srcIndex
        })
      }
    }
  }
}
