/** Pure data layer of the curve panel: property building from clip events +
 *  edit overlays, selection identities, patch types, and the one traversal
 *  over everything drawn (points + knots). No React, no DOM. */
import { clipCurve, unshadowedPoints } from '../../../shared/curve'
import { applyEditsIndexed } from '../../../shared/edits'
import type { ClipCurve, ClipEdits, CurveKnot, OscEvent } from '../../../shared/types'
import type { ClipInst } from '../timeline/model'
import type { GeomEl } from './curveGeom'

/** Distinct color per property: golden-angle hues stay spread out at any
 *  count; lightness cycles so neighboring hues still read apart. */
export function propColor(i: number): string {
  const hue = (210 + i * 137.508) % 360
  const light = [65, 55, 75][i % 3]
  return `hsl(${hue.toFixed(1)}, 75%, ${light}%)`
}

/** Candidate grid intervals; 0.1 for values, 1s for time at typical scales. */
const GRID_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120]

/** Min px between time grid lines; fits a HH:MM:SS.mmm label. */
export const TIME_GRID_MIN_PX = 90

/** Smallest step that keeps grid lines at least minPx apart. */
export function gridStep(range: number, pixels: number, minPx: number): number {
  for (const s of GRID_STEPS) {
    if ((s / range) * pixels >= minPx) return s
  }
  return GRID_STEPS[GRID_STEPS.length - 1]
}

/** Decimal places needed to print multiples of step exactly. */
export function stepDecimals(step: number): number {
  return Math.max(0, -Math.floor(Math.log10(step)))
}

/** Short number for the hover tooltip: ≤3 decimals, no trailing zeros. */
export function fmt(n: number): string {
  return String(Number(n.toFixed(3)))
}

export const MAX_ZOOM = 50

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
   *  from trim clipping (drawn but not editable). */
  knots: (CurveKnot & { srcIndex: number })[]
}

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
  edits: Record<string, ClipEdits>
): Property[] {
  const byKey = new Map<string, CurvePoint[]>()
  const curvesByKey = new Map<string, PropCurve[]>()
  const argCount = new Map<string, number>()
  for (const { clip, events } of clipEvents) {
    for (const { ev, idx } of applyEditsIndexed(events, edits[clip.file])) {
      if (ev.t < clip.trimIn || ev.t > clip.trimOut) continue
      ev.args.forEach((arg, argIndex) => {
        if (typeof arg !== 'number') return
        argCount.set(ev.a, Math.max(argCount.get(ev.a) ?? 1, ev.args.length))
        const key = `${ev.a} ${argIndex}`
        let pts = byKey.get(key)
        if (!pts) byKey.set(key, (pts = []))
        pts.push({
          t: clip.offset + (ev.t - clip.trimIn),
          v: arg,
          eventIndex: idx,
          argIndex,
          clip,
          ev
        })
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
      list.push({
        clip,
        curveIndex: ci,
        src: c,
        knots: clipped.map((k) => ({
          ...k,
          t: clip.offset + (k.t - clip.trimIn),
          // Interior knots are copied verbatim by clipCurve, so an exact
          // t match identifies the source knot; boundary splits get -1.
          srcIndex: c.knots.findIndex((sk) => sk.t === k.t)
        }))
      })
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
    // Points inside a span never play (the curve outranks them for good —
    // unshadowedPoints), so the merged path skips them; the dots still draw
    // from `points` so they stay visible and editable.
    const spans = curves.map((pc) => ({
      start: pc.knots[0].t,
      end: pc.knots[pc.knots.length - 1].t
    }))
    const els: GeomEl[] = [
      ...unshadowedPoints(points, spans).map((pt) => ({ t: pt.t, v: pt.v })),
      ...curves.map((pc, ci) => ({ t: pc.knots[0].t, knots: pc.knots, curve: ci }))
    ].sort((a, b) => a.t - b.t)
    return { key, label, color: propColor(i), points, curves, els, min, max }
  })
}

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
