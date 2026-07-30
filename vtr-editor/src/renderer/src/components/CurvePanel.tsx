import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Magnet, Maximize2, Pencil, Spline, SquareDashed } from 'lucide-react'
import { clipCurve } from '../../../shared/curve'
import { applyEditsIndexed } from '../../../shared/edits'
import type { ClipCurve, ClipEdits, CurveKnot, OscEvent } from '../../../shared/types'
import { ClipInst, clipLen, formatRulerLabel } from '../timeline/model'
import { applyKnotMoves, setKnotHandle } from './curveEdit'
import { MIN_FIT_POINTS, buildCurveReplace } from './curveReplace'
import {
  PAD,
  fitZoomX,
  hitCurve,
  hitKnot,
  hitPoint,
  tAt,
  vAt,
  valueAt,
  visibleRange,
  walkMerged,
  xAt,
  yAt,
  type GeomEl,
  type Scale
} from './curveGeom'
import { eventsCache } from './eventsCache'
import type { PlayingState } from './Timeline'

/** e2e hooks: curves/points are canvas pixels, not DOM nodes, so tests read
 *  their geometry (in client coordinates) from these. */
declare global {
  interface Window {
    __curveProps?: {
      key: string
      label: string
      selected: boolean
      dimmed: boolean
      pointCount: number
      curveCount: number
    }[]
    __curvePoints?: {
      label: string
      x: number
      y: number
      selected: boolean
      t: number
      v: number
    }[]
    __curveKnots?: {
      label: string
      x: number
      y: number
      t: number
      v: number
      selected: boolean
    }[]
  }
}

/** Hit radii, px: points win over curve lines (the old SVG stacking order). */
const POINT_HIT_PX = 6
const CURVE_HIT_PX = 5

/** Distinct color per property: golden-angle hues stay spread out at any
 *  count; lightness cycles so neighboring hues still read apart. */
function propColor(i: number): string {
  const hue = (210 + i * 137.508) % 360
  const light = [65, 55, 75][i % 3]
  return `hsl(${hue.toFixed(1)}, 75%, ${light}%)`
}
/** Horizontal travel between points added by a pencil-drag stroke. */
const DRAW_STEP_PX = 4

/** Candidate grid intervals; 0.1 for values, 1s for time at typical scales. */
const GRID_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120]

/** Min px between time grid lines; fits a HH:MM:SS.mmm label. */
const TIME_GRID_MIN_PX = 90

/** Smallest step that keeps grid lines at least minPx apart. */
function gridStep(range: number, pixels: number, minPx: number): number {
  for (const s of GRID_STEPS) {
    if ((s / range) * pixels >= minPx) return s
  }
  return GRID_STEPS[GRID_STEPS.length - 1]
}

/** Decimal places needed to print multiples of step exactly. */
function stepDecimals(step: number): number {
  return Math.max(0, -Math.floor(Math.log10(step)))
}

/** Short number for the hover tooltip: ≤3 decimals, no trailing zeros. */
function fmt(n: number): string {
  return String(Number(n.toFixed(3)))
}

const MAX_ZOOM = 50
/** Header sliders run 0..100 and map to 1..MAX_ZOOM exponentially. */
function zoomToSlider(z: number): number {
  return (100 * Math.log(z)) / Math.log(MAX_ZOOM)
}
function sliderToZoom(v: number): number {
  return Math.pow(MAX_ZOOM, v / 100)
}

interface CurvePoint {
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
interface PropCurve {
  clip: ClipInst
  /** Index into the clip overlay's curves array (ClipEdits key space). */
  curveIndex: number
  /** The overlay record itself (clip-local knots; edits rebuild from it). */
  src: ClipCurve
  /** srcIndex maps back into src.knots; -1 marks synthetic boundary knots
   *  from trim clipping (drawn but not editable). */
  knots: (CurveKnot & { srcIndex: number })[]
}

interface Property {
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

function buildProperties(
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
    const els: GeomEl[] = [
      ...points.map((pt) => ({ t: pt.t, v: pt.v })),
      ...curves.map((pc, ci) => ({ t: pc.knots[0].t, knots: pc.knots, curve: ci }))
    ].sort((a, b) => a.t - b.t)
    return { key, label, color: propColor(i), points, curves, els, min, max }
  })
}

function useSize(ref: React.RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
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

function selKey(s: PointSel): string {
  return 'curveIndex' in s
    ? `${s.file}:c${s.curveIndex}:${s.knotIndex}`
    : `${s.file}:${s.eventIndex}:${s.argIndex}`
}

function ptSel(pt: CurvePoint): EventPointSel {
  return { file: pt.clip.file, eventIndex: pt.eventIndex, argIndex: pt.argIndex }
}

function knotSel(pc: PropCurve, srcIndex: number): KnotSel {
  return { file: pc.clip.file, curveIndex: pc.curveIndex, knotIndex: srcIndex }
}

/** One appended point: the overlay event plus its selection identity. */
export interface PointAdd {
  sel: EventPointSel
  ev: OscEvent
}

interface HoverInfo {
  px: number
  py: number
  anchor: 'start' | 'end'
  text: string
}

/** Tooltip in its own component: pointermove feeds it through a subscription,
 *  so hovering never re-renders (and reconciles) the whole point cloud. */
const HoverTooltip = React.memo(function HoverTooltip({
  subscribe
}: {
  subscribe: (fn: (info: HoverInfo | null) => void) => () => void
}): React.JSX.Element | null {
  const [info, setInfo] = useState<HoverInfo | null>(null)
  useEffect(() => subscribe(setInfo), [subscribe])
  if (!info) return null
  return (
    <text className="curve-tooltip" x={info.px + 8} y={info.py - 8} textAnchor={info.anchor}>
      {info.text}
    </text>
  )
})

/** Playhead line over the ruler + curves; rAF-follows playback like the
 *  timeline's PlayheadLine. toPx maps timeline seconds to viewport px. */
function CurvePlayhead({
  playhead,
  playing,
  toPx
}: {
  playhead: number
  playing: PlayingState | null
  toPx: (sec: number) => number
}): React.JSX.Element {
  const [, force] = useState(0)
  useEffect(() => {
    if (!playing) return
    let raf: number
    const loop = (): void => {
      force((x) => x + 1)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing])
  const sec = playing
    ? Math.min(playing.startPos + (performance.now() - playing.startedAt) / 1000, playing.duration)
    : playhead
  return (
    <div className="curve-playhead" style={{ left: toPx(sec) }}>
      <div className="curve-playhead-head" />
    </div>
  )
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

export function CurvePanel({
  clips,
  edits,
  height,
  playhead,
  playing,
  onSeek,
  selectedPoints,
  onSelectPoints,
  onPointEdit,
  onPointAdd,
  onCurveReplace
}: {
  /** Every clip whose events are shown; empty shows the placeholder. */
  clips: ClipInst[]
  edits: Record<string, ClipEdits>
  /** Panel height, px (the splitter above drives it). */
  height: number
  playhead: number
  playing: PlayingState | null
  onSeek: (sec: number) => void
  selectedPoints: PointSel[]
  onSelectPoints: (pts: PointSel[]) => void
  /** Streams transient patches while dragging; isCommit on release. */
  onPointEdit: (patches: PointPatch[], isCommit: boolean) => void
  /** Appends events to the clips' edit overlays. A pencil stroke streams
   *  single adds (transient) and re-sends the whole batch with isCommit. */
  onPointAdd: (adds: PointAdd[], isCommit: boolean) => void
  /** Replaces points atomically: one undo entry for the deletes + curve adds. */
  onCurveReplace: (
    dels: { file: string; eventIndex: number }[],
    adds: { file: string; curve: ClipCurve }[]
  ) => void
}): React.JSX.Element {
  // Events per clip path; the cache never goes stale (files are immutable).
  const [loaded, setLoaded] = useState<Map<string, OscEvent[]>>(new Map())
  // Visibility is keyed by address, so it usefully carries across clip selections.
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  // Name filter: narrows the property list and the drawn curves.
  const [filter, setFilter] = useState('')
  // Header toggles: snap point edits to the grid; show the transform box;
  // pencil (clicks add points to the selected curve).
  const [snap, setSnap] = useState(false)
  const [useBox, setUseBox] = useState(true)
  const [pencil, setPencil] = useState(false)
  // Selected properties: their curves draw thicker and win the hover tooltip.
  const [selectedProps, setSelectedProps] = useState<Set<string>>(new Set())
  const editorRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const { w, h } = useSize(editorRef)

  // Pinch (ctrl+wheel) or the X slider zooms the time axis; 1 = the time
  // range fits the panel. The Y slider zooms the value axis; past 1 the
  // editor scrolls vertically.
  const [zoomX, setZoomX] = useState(1)
  const [zoomY, setZoomY] = useState(1)
  const innerW = w * zoomX
  const innerH = h * zoomY
  // Scroll offsets of .curve-scroll; scrollTop pins the value labels,
  // scrollLeft keeps the ruler and playhead in sync with the curves.
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  // Normalized time position under the cursor at pinch start; scroll is
  // restored after the zoomed width renders so that point stays put.
  const pinchAnchor = useRef<{ norm: number; viewX: number } | null>(null)
  // scrollLeft to apply after a fit-zoom re-render, same timing as the pinch.
  const fitScroll = useRef<number | null>(null)

  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const scroll = scrollRef.current
      if (!e.ctrlKey || !scroll) return
      e.preventDefault()
      // Anchor from the DOM, not React state: pinch events outrun re-renders,
      // and scrollLeft/scrollWidth are always consistent with each other.
      const viewX = e.clientX - el.getBoundingClientRect().left
      pinchAnchor.current = {
        norm: (scroll.scrollLeft + viewX - PAD) / Math.max(scroll.scrollWidth - 2 * PAD, 1),
        viewX
      }
      setZoomX((z) => Math.min(Math.max(z * Math.exp(-e.deltaY * 0.01), 1), MAX_ZOOM))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const a = pinchAnchor.current
    const f = fitScroll.current
    if (a) {
      pinchAnchor.current = null
      el.scrollLeft = PAD + a.norm * (w * zoomX - 2 * PAD) - a.viewX
    } else if (f != null) {
      fitScroll.current = null
      el.scrollLeft = f
    } else return
    // Sync the state before paint: the ruler and playhead sit outside the
    // scroll container and translate by this value; waiting for the scroll
    // event would paint one frame with the new scale but the old offset.
    setScrollLeft(el.scrollLeft)
  }, [zoomX, w])

  // Load events for every shown clip. Keyed by the joined paths so a new
  // clips array with the same files doesn't refetch.
  const pathsKey = clips.map((c) => c.path).join('\n')
  useEffect(() => {
    const paths = pathsKey === '' ? [] : pathsKey.split('\n')
    const missing = [...new Set(paths.filter((p) => !eventsCache.has(p)))]
    let stale = false
    Promise.all(
      missing.map((p) =>
        window.api.clip
          .events(p)
          .then((events) => eventsCache.set(p, events))
          // Don't cache failures: a transient read error (e.g. file mid-move
          // during save) would blank the clip's curves for the whole session.
          .catch(() => undefined)
      )
    ).then(() => {
      if (stale) return
      setLoaded(new Map(paths.map((p) => [p, eventsCache.get(p) ?? []])))
    })
    return () => {
      stale = true
    }
  }, [pathsKey])

  // Only clips whose events already arrived draw; the rest pop in on load.
  // Keyed on the clip fields that actually feed buildProperties, not the
  // clips array identity: timeline drag transients rebuild the array every
  // pointermove without touching the shown clips' placement or events.
  const clipsKey = clips
    .map((c) => `${c.id} ${c.offset} ${c.trimIn} ${c.trimOut} ${c.file} ${c.path}`)
    .join('\n')
  const curves = useMemo(() => {
    const ready = clips.flatMap((clip) => {
      const events = loaded.get(clip.path)
      return events ? [{ clip, events }] : []
    })
    return buildProperties(ready, edits)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clipsKey covers clips
  }, [clipsKey, loaded, edits])

  // Properties that pass the name filter; everything drawn works off this.
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q === '' ? curves : curves.filter((p) => p.label.toLowerCase().includes(q))
  }, [curves, filter])

  const toggle = (key: string): void => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Click selects one property (click again deselects); shift toggles membership.
  const selectProp = (key: string, additive: boolean): void => {
    setSelectedProps((prev) => {
      if (additive) {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }
      return prev.size === 1 && prev.has(key) ? new Set() : new Set([key])
    })
  }

  // With a property selection, other curves fade out and lose their points.
  const dimmed = (key: string): boolean => selectedProps.size > 0 && !selectedProps.has(key)

  // Time domain: the union of the shown clips' timeline spans.
  const tMin = clips.length > 0 ? Math.min(...clips.map((c) => c.offset)) : 0
  const tMax = clips.length > 0 ? Math.max(...clips.map((c) => c.offset + clipLen(c))) : 0
  const tRange = Math.max(tMax - tMin, 1e-9)

  const scale: Scale = { tMin, tRange, innerW, innerH }
  const x = (t: number): number => xAt(scale, t)
  const y = (p: Property, v: number): number => yAt(scale, p, v)

  const selKeys = useMemo(() => new Set(selectedPoints.map(selKey)), [selectedPoints])

  // Replace with Curve targets: the selected points, else the selected
  // properties' full point sets. Each (property, clip) group needs
  // MIN_FIT_POINTS to convert; smaller groups are left alone.
  const replaceTargets = (): CurvePoint[] => {
    const usePointSel = selKeys.size > 0
    const chosen: CurvePoint[] = []
    for (const p of shown) {
      if (hidden.has(p.key) || dimmed(p.key)) continue
      if (!usePointSel && !selectedProps.has(p.key)) continue
      const byClip = new Map<number, CurvePoint[]>()
      for (const pt of p.points) {
        if (usePointSel && !selKeys.has(selKey(ptSel(pt)))) continue
        let list = byClip.get(pt.clip.id)
        if (!list) byClip.set(pt.clip.id, (list = []))
        list.push(pt)
      }
      for (const pts of byClip.values()) {
        if (pts.length >= MIN_FIT_POINTS) chosen.push(...pts)
      }
    }
    return chosen
  }
  const canReplace = clips.length > 0 && replaceTargets().length > 0

  const replaceWithCurve = (): void => {
    const targets = replaceTargets()
    if (targets.length === 0) return
    const rep = buildCurveReplace(
      targets.map((pt) => ({ file: pt.clip.file, eventIndex: pt.eventIndex, ev: pt.ev }))
    )
    if (rep) onCurveReplace(rep.dels, rep.adds)
  }

  // Fit the X zoom to the selected points, else the selected curves (via
  // dimmed()), else everything shown. Vertical zoom stays put.
  const fitZoom = (): void => {
    const span = (usePointSel: boolean): [number, number] => {
      let t0 = Infinity
      let t1 = -Infinity
      for (const p of shown) {
        if (hidden.has(p.key) || dimmed(p.key)) continue
        for (const pt of p.points) {
          if (usePointSel && !selKeys.has(selKey(ptSel(pt)))) continue
          t0 = Math.min(t0, pt.t)
          t1 = Math.max(t1, pt.t)
        }
        for (const pc of p.curves) {
          for (const k of pc.knots) {
            if (usePointSel && !(k.srcIndex >= 0 && selKeys.has(selKey(knotSel(pc, k.srcIndex))))) {
              continue
            }
            t0 = Math.min(t0, k.t)
            t1 = Math.max(t1, k.t)
          }
        }
      }
      return [t0, t1]
    }
    let [t0, t1] = span(selKeys.size > 0)
    // Selected points all on hidden/dimmed curves: fit the visible ones.
    if (t1 < t0 && selKeys.size > 0) [t0, t1] = span(false)
    if (t1 < t0) return // nothing to fit
    const fit = fitZoomX(w, tMin, tRange, t0, t1, MAX_ZOOM)
    if (!fit) return
    if (fit.zoomX === zoomX) {
      // No re-render coming, so the layout effect won't fire; scroll directly.
      const el = scrollRef.current
      if (el) {
        el.scrollLeft = fit.scrollLeft
        setScrollLeft(el.scrollLeft)
      }
    } else {
      fitScroll.current = fit.scrollLeft
      setZoomX(fit.zoomX)
    }
  }

  // Snap on: dragged times/values lock onto the same grid the editor draws.
  const snapTime = (t: number): number => {
    if (!snap) return t
    const step = gridStep(tRange, innerW - 2 * PAD, TIME_GRID_MIN_PX)
    return Math.round(t / step) * step
  }
  const snapValue = (v: number, min: number, max: number): number => {
    if (!snap || max <= min) return v
    const step = gridStep(max - min, innerH - 2 * PAD, 18)
    return Math.round(v / step) * step
  }

  // Drag targets: discrete points and bezier knots move under the same
  // rules. Positions and value scales are frozen at drag start so the
  // streaming edits don't feed back; knots keep a handle on the frozen
  // overlay record (src) so each move rebuilds the whole knot array from it.
  type DragTarget =
    | { pt: CurvePoint; min: number; max: number }
    | { pc: PropCurve; srcIndex: number; t: number; v: number; min: number; max: number }

  /** A target's frozen timeline position + value scale. */
  const targetPos = (target: DragTarget): { t: number; v: number; min: number; max: number } =>
    'pt' in target ? { t: target.pt.t, v: target.pt.v, min: target.min, max: target.max } : target

  /** Every drawn point/knot in the given selection (drag/xform group). */
  const dragTargets = (sel: Set<string>): DragTarget[] => {
    const targets: DragTarget[] = []
    for (const p of curves) {
      for (const cp of p.points) {
        if (sel.has(selKey(ptSel(cp)))) targets.push({ pt: cp, min: p.min, max: p.max })
      }
      for (const pc of p.curves) {
        for (const k of pc.knots) {
          if (k.srcIndex < 0 || !sel.has(selKey(knotSel(pc, k.srcIndex)))) continue
          targets.push({ pc, srcIndex: k.srcIndex, t: k.t, v: k.v, min: p.min, max: p.max })
        }
      }
    }
    return targets
  }

  /** Target moves (new timeline t + value) → patches. Point moves map onto
   *  event patches; knot moves collapse into one whole-array patch per
   *  curve, with order and handle invariants enforced by applyKnotMoves. */
  const movePatches = (moves: { target: DragTarget; tl: number; v: number }[]): PointPatch[] => {
    const out: PointPatch[] = []
    const byCurve = new Map<string, { pc: PropCurve; m: Map<number, { t: number; v: number }> }>()
    for (const { target, tl, v } of moves) {
      const c = 'pt' in target ? target.pt.clip : target.pc.clip
      const clamped = Math.min(Math.max(tl, c.offset), c.offset + clipLen(c))
      const tLocal = c.trimIn + (clamped - c.offset)
      if ('pt' in target) {
        out.push({
          file: c.file,
          eventIndex: target.pt.eventIndex,
          t: tLocal,
          argIndex: target.pt.argIndex,
          value: v
        })
      } else {
        const key = `${c.file}:${target.pc.curveIndex}`
        let g = byCurve.get(key)
        if (!g) byCurve.set(key, (g = { pc: target.pc, m: new Map() }))
        g.m.set(target.srcIndex, { t: tLocal, v })
      }
    }
    for (const { pc, m } of byCurve.values()) {
      out.push({
        file: pc.clip.file,
        curveIndex: pc.curveIndex,
        knots: applyKnotMoves(pc.src.knots, m)
      })
    }
    return out
  }

  const drag = useRef<{
    targets: DragTarget[]
    startX: number
    startY: number
    moved: boolean
    last: PointPatch[] | null
  } | null>(null)

  const startPointDrag = (e: React.PointerEvent<HTMLDivElement>, sel: PointSel): void => {
    const key = selKey(sel)
    if (e.shiftKey) {
      // Shift toggles membership; no drag.
      onSelectPoints(
        selKeys.has(key)
          ? selectedPoints.filter((s) => selKey(s) !== key)
          : [...selectedPoints, sel]
      )
      return
    }
    // Grabbing an unselected point selects just it; a selected one drags the group.
    const group = selKeys.has(key) ? selKeys : new Set([key])
    if (!selKeys.has(key)) onSelectPoints([sel])
    drag.current = {
      targets: dragTargets(group),
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      last: null
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    d.moved = true
    const dt = (dx / Math.max(innerW - 2 * PAD, 1)) * tRange
    d.last = movePatches(
      d.targets.map((target) => {
        const { t, v, min, max } = targetPos(target)
        return {
          target,
          tl: snapTime(t + dt),
          v: snapValue(v + (-dy / Math.max(innerH - 2 * PAD, 1)) * (max - min || 1), min, max)
        }
      })
    )
    onPointEdit(d.last, false)
  }

  const onPointUp = (): void => {
    const d = drag.current
    drag.current = null
    // One undo entry per drag: replay the final values as the commit.
    if (d?.last) onPointEdit(d.last, true)
  }

  // Transform box: with 2+ points selected, a box wraps them. Dragging its
  // body moves the group; dragging an edge scales the group toward the
  // opposite edge. All math runs in pixel space on positions frozen at drag
  // start, then converts back per point (t clamped to the point's clip span,
  // value in the property's frozen scale — same rules as a point drag).
  type XformMode = 'move' | 'left' | 'right' | 'top' | 'bottom'
  interface Box {
    x: number
    y: number
    w: number
    h: number
  }

  /** Drawn selected points + knots (hidden/dimmed curves excluded), with
   *  their frozen pixel positions. Feeds the box bounds and xform targets. */
  const drawnSelected = (): (DragTarget & { px0: number; py0: number })[] => {
    const out: (DragTarget & { px0: number; py0: number })[] = []
    for (const p of shown) {
      if (hidden.has(p.key) || dimmed(p.key)) continue
      for (const pt of p.points) {
        if (!selKeys.has(selKey(ptSel(pt)))) continue
        out.push({ pt, min: p.min, max: p.max, px0: x(pt.t), py0: y(p, pt.v) })
      }
      for (const pc of p.curves) {
        for (const k of pc.knots) {
          if (k.srcIndex < 0 || !selKeys.has(selKey(knotSel(pc, k.srcIndex)))) continue
          out.push({
            pc,
            srcIndex: k.srcIndex,
            t: k.t,
            v: k.v,
            min: p.min,
            max: p.max,
            px0: x(k.t),
            py0: y(p, k.v)
          })
        }
      }
    }
    return out
  }

  // Bounding box of the drawn selected points (hidden/dimmed curves excluded).
  const selBox = ((): Box | null => {
    if (!useBox || selectedPoints.length < 2 || clips.length === 0) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let n = 0
    for (const { px0, py0 } of drawnSelected()) {
      x0 = Math.min(x0, px0)
      y0 = Math.min(y0, py0)
      x1 = Math.max(x1, px0)
      y1 = Math.max(y1, py0)
      n++
    }
    return n >= 2 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
  })()

  const xform = useRef<{
    mode: XformMode
    startX: number
    startY: number
    box0: Box
    targets: (DragTarget & { px0: number; py0: number })[]
    moved: boolean
    last: PointPatch[] | null
  } | null>(null)

  const beginXform = (e: React.PointerEvent, mode: XformMode, box: Box): void => {
    const targets = drawnSelected()
    xform.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      box0: box,
      targets,
      moved: false,
      last: null
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const applyXform = (e: React.PointerEvent): void => {
    const d = xform.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    d.moved = true
    const b = d.box0
    // Edges scale toward the opposite (anchored) edge; zero extent is a noop.
    const map = (px: number, py: number): { nx: number; ny: number } => {
      switch (d.mode) {
        case 'move':
          return { nx: px + dx, ny: py + dy }
        case 'left':
          return { nx: b.w > 0 ? b.x + b.w - ((b.x + b.w - px) * (b.w - dx)) / b.w : px, ny: py }
        case 'right':
          return { nx: b.w > 0 ? b.x + ((px - b.x) * (b.w + dx)) / b.w : px, ny: py }
        case 'top':
          return { nx: px, ny: b.h > 0 ? b.y + b.h - ((b.y + b.h - py) * (b.h - dy)) / b.h : py }
        case 'bottom':
          return { nx: px, ny: b.h > 0 ? b.y + ((py - b.y) * (b.h + dy)) / b.h : py }
      }
    }
    d.last = movePatches(
      d.targets.map((target) => {
        const { nx, ny } = map(target.px0, target.py0)
        const { v, min, max } = targetPos(target)
        return {
          target,
          tl: snapTime(tAt(scale, nx)),
          v: snapValue(
            v + (-(ny - target.py0) / Math.max(innerH - 2 * PAD, 1)) * (max - min || 1),
            min,
            max
          )
        }
      })
    )
    onPointEdit(d.last, false)
  }

  /** Ends an xform drag; a plain click (no move) on the box body clears the selection. */
  const endXform = (clearIfUnmoved: boolean): void => {
    const d = xform.current
    xform.current = null
    if (!d) return
    if (d.last) onPointEdit(d.last, true)
    else if (!d.moved && clearIfUnmoved) onSelectPoints([])
  }

  const onEdgeDown = (e: React.PointerEvent<SVGRectElement>, mode: XformMode): void => {
    if (e.button !== 0 || !selBox) return
    e.stopPropagation()
    beginXform(e, mode, selBox)
  }

  // Bezier handles: every selected knot shows its incoming/outgoing handle
  // (the linear-third default where the knot has none yet), draggable to
  // reshape the segment. Handle offsets are clip-local seconds, which map
  // 1:1 onto timeline seconds (offset/trim only translate).
  interface HandleView {
    p: Property
    pc: PropCurve
    srcIndex: number
    side: 'i' | 'o'
    /** Knot position: timeline t / property-scale v, and pixels. */
    kt: number
    kv: number
    kx: number
    ky: number
    /** Handle end, pixels. */
    hx: number
    hy: number
  }

  const handleViews = (): HandleView[] => {
    if (clips.length === 0) return []
    const out: HandleView[] = []
    for (const p of interactiveProps()) {
      for (const pc of p.curves) {
        for (const k of pc.knots) {
          if (k.srcIndex < 0 || !selKeys.has(selKey(knotSel(pc, k.srcIndex)))) continue
          const kn = pc.src.knots
          const i = k.srcIndex
          const mk = (side: 'i' | 'o', dt: number, dv: number): void => {
            out.push({
              p,
              pc,
              srcIndex: i,
              side,
              kt: k.t,
              kv: k.v,
              kx: x(k.t),
              ky: y(p, k.v),
              hx: x(k.t + dt),
              hy: y(p, k.v + dv)
            })
          }
          if (i > 0) {
            const [dt, dv] = kn[i].i ?? [(kn[i - 1].t - kn[i].t) / 3, (kn[i - 1].v - kn[i].v) / 3]
            mk('i', dt, dv)
          }
          if (i + 1 < kn.length) {
            const [dt, dv] = kn[i].o ?? [(kn[i + 1].t - kn[i].t) / 3, (kn[i + 1].v - kn[i].v) / 3]
            mk('o', dt, dv)
          }
        }
      }
    }
    return out
  }

  const handleDrag = useRef<{
    pc: PropCurve
    srcIndex: number
    side: 'i' | 'o'
    kt: number
    kv: number
    min: number
    max: number
    last: CurvePatch | null
  } | null>(null)

  const onHandleDown = (e: React.PointerEvent<SVGCircleElement>, h: HandleView): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    handleDrag.current = {
      pc: h.pc,
      srcIndex: h.srcIndex,
      side: h.side,
      kt: h.kt,
      kv: h.kv,
      min: h.p.min,
      max: h.p.max,
      last: null
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onHandleMove = (pos: { x: number; y: number }, axisLock: boolean): void => {
    const d = handleDrag.current
    if (!d) return
    let dt = tAt(scale, pos.x) - d.kt
    let dv = vAt(scale, { min: d.min, max: d.max }, pos.y) - d.kv
    if (axisLock) {
      // Shift: lock the handle to the knot's dominant pixel axis — flat
      // (horizontal) or straight up/down (vertical).
      const dxPx = pos.x - xAt(scale, d.kt)
      const dyPx = pos.y - yAt(scale, { min: d.min, max: d.max }, d.kv)
      if (Math.abs(dxPx) >= Math.abs(dyPx)) dv = 0
      else dt = 0
    }
    d.last = {
      file: d.pc.clip.file,
      curveIndex: d.pc.curveIndex,
      knots: setKnotHandle(d.pc.src.knots, d.srcIndex, d.side, dt, dv)
    }
    onPointEdit([d.last], false)
  }

  // Hover: the tooltip always shows the point nearest to the cursor (px
  // distance). Selected properties win; otherwise all visible points compete.
  // The scan runs per pointermove but feeds only the HoverTooltip child, so
  // the point cloud itself never re-renders on hover.
  const computeHover = (mouse: { x: number; y: number }): HoverInfo | null => {
    if (clips.length === 0) return null
    const visible = shown.filter((p) => !hidden.has(p.key))
    const sel = visible.filter((p) => selectedProps.has(p.key))
    let best: HoverInfo | null = null
    let bestD = Infinity
    for (const p of sel.length > 0 ? sel : visible) {
      const consider = (t: number, v: number): void => {
        const px = x(t)
        const py = y(p, v)
        const d = (px - mouse.x) ** 2 + (py - mouse.y) ** 2
        if (d < bestD) {
          bestD = d
          best = {
            px,
            py,
            anchor: px > innerW - 120 ? 'end' : 'start',
            text: `${p.label}: ${fmt(v)} @ ${fmt(t)}s`
          }
        }
      }
      for (const pt of p.points) consider(pt.t, pt.v)
      for (const pc of p.curves) for (const k of pc.knots) consider(k.t, k.v)
    }
    return best
  }
  // Fresh closure every render; pointermove reads the latest through the ref.
  const computeHoverRef = useRef(computeHover)
  useEffect(() => {
    computeHoverRef.current = computeHover
  })
  const hoverListener = useRef<((info: HoverInfo | null) => void) | null>(null)
  const subscribeHover = useCallback((fn: (info: HoverInfo | null) => void) => {
    hoverListener.current = fn
    return () => {
      if (hoverListener.current === fn) hoverListener.current = null
    }
  }, [])
  const updateHover = (pos: { x: number; y: number } | null): void => {
    hoverListener.current?.(pos && computeHoverRef.current(pos))
  }

  // Marquee: drag on empty editor space rubber-bands a selection. A plain
  // click (< 3px) clears it, matching the old deselect behavior.
  const marquee = useRef<{
    x0: number
    y0: number
    base: PointSel[]
    moved: boolean
    clear: boolean
  } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)

  // A plain press on a curve line doesn't toggle the selection right away:
  // the toggle waits SELECT_DELAY_MS so a double-click (point insert) never
  // touches the selection, not even transiently. A second press nearby
  // within the window drops it; any other press applies it first. (Chromium
  // leaves pointerdown.detail at 0, so double presses are detected by hand.)
  const pendingSel = useRef<{ timer: number; x: number; y: number; apply: () => void } | null>(null)
  const SELECT_DELAY_MS = 300
  const DBL_PX = 8

  /** Clears the pending curve-select toggle; applies it unless dropped. */
  const settlePendingSel = (drop: boolean): void => {
    const pend = pendingSel.current
    if (!pend) return
    window.clearTimeout(pend.timer)
    pendingSel.current = null
    if (!drop) pend.apply()
  }

  /** Pointer position in svg coordinates (follows both scroll axes). */
  const svgPos = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = editorRef.current!.getBoundingClientRect()
    return {
      x: e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0),
      y: e.clientY - rect.top + (scrollRef.current?.scrollTop ?? 0)
    }
  }

  // Build one point insert on p at the given position. The nearest existing
  // point supplies the event template (clip, port, other args); t is clamped
  // to that clip's span. addCount gives the clip overlay's current add count
  // (base + points added earlier in a stroke), which fixes the event index.
  // With onCurve the value comes from the curve at t (the cursor's y is
  // ignored), so an insert never nudges the curve.
  const makeAdd = (
    p: Property,
    pos: { x: number; y: number },
    addCount: (file: string) => number,
    onCurve = false
  ): PointAdd | null => {
    if (p.points.length === 0) return null
    const t = snapTime(tAt(scale, pos.x))
    const v = onCurve ? valueAt(p.points, t) : snapValue(vAt(scale, p, pos.y), p.min, p.max)
    let tpl = p.points[0]
    for (const pt of p.points) {
      if (Math.abs(pt.t - t) < Math.abs(tpl.t - t)) tpl = pt
    }
    const c = tpl.clip
    const events = loaded.get(c.path)
    if (!events) return null
    const tl = Math.min(Math.max(t, c.offset), c.offset + clipLen(c))
    const args = [...tpl.ev.args]
    args[tpl.argIndex] = v
    return {
      sel: {
        file: c.file,
        eventIndex: events.length + addCount(c.file),
        argIndex: tpl.argIndex
      },
      ev: { t: c.trimIn + (tl - c.offset), port: tpl.ev.port, a: tpl.ev.a, args }
    }
  }

  /** Single insert (double-click / cmd+click): one point on the curve at the
   *  clicked time, one undo entry. */
  const addPointAt = (p: Property, pos: { x: number; y: number }): void => {
    const add = makeAdd(p, pos, (file) => edits[file]?.add?.length ?? 0, true)
    if (add) onPointAdd([add], true)
  }

  // Pencil stroke: pointerdown starts it, every DRAW_STEP_PX of horizontal
  // travel adds another point, pointerup commits the batch as one undo entry.
  // The property (value scale + templates) and the pre-stroke edits are
  // frozen at stroke start: transient adds mutate `edits` mid-stroke, and
  // the commit replays the whole batch onto the pre-stroke doc.
  const draw = useRef<{
    prop: Property
    edits0: Record<string, ClipEdits>
    adds: PointAdd[]
    lastX: number
  } | null>(null)

  const drawAt = (pos: { x: number; y: number }): void => {
    const d = draw.current
    if (!d) return
    const add = makeAdd(
      d.prop,
      pos,
      (file) =>
        (d.edits0[file]?.add?.length ?? 0) + d.adds.filter((a) => a.sel.file === file).length
    )
    if (!add) return
    // Snap can land two samples on the same grid line; keep the first.
    if (d.adds.some((a) => a.sel.file === add.sel.file && a.ev.t === add.ev.t)) return
    d.adds.push(add)
    d.lastX = pos.x
    onPointAdd([add], false)
  }

  const beginDraw = (p: Property, pos: { x: number; y: number }): void => {
    draw.current = { prop: p, edits0: edits, adds: [], lastX: pos.x }
    drawAt(pos)
  }

  const endDraw = (): void => {
    const d = draw.current
    draw.current = null
    if (d && d.adds.length > 0) onPointAdd(d.adds, true)
  }

  // Curves/points live on the canvas, so the editor div owns every pointer
  // interaction. Priority mirrors the old SVG stacking: xform edges (still
  // SVG, stopPropagation) > points > curve lines > pencil > box body > marquee.
  const interactiveProps = (): Property[] =>
    shown.filter((p) => !hidden.has(p.key) && !dimmed(p.key))

  /** The selected curve, if visible: pencil and cmd+click target it. */
  const selectedCurve = (): Property | undefined =>
    shown.find((p) => selectedProps.has(p.key) && !hidden.has(p.key))

  const onEditorDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    if (clips.length === 0) {
      onSelectPoints([])
      return
    }
    const pos = svgPos(e)
    // A quick second press near a pending curve-select is a double-click:
    // drop the toggle (the dblclick inserts a point instead). Any other
    // press applies the pending toggle before it is handled.
    const isDouble =
      pendingSel.current != null &&
      Math.abs(pos.x - pendingSel.current.x) < DBL_PX &&
      Math.abs(pos.y - pendingSel.current.y) < DBL_PX
    settlePendingSel(isDouble)
    const props = interactiveProps()
    // A point under the cursor: select / drag it (the group if selected).
    const ph = hitPoint(props, scale, pos, POINT_HIT_PX)
    if (ph) {
      startPointDrag(e, ptSel(props[ph.prop].points[ph.point]))
      return
    }
    // A bezier knot: same select/drag semantics as a point. Synthetic trim
    // boundary knots aren't editable and fall through to the curve line.
    const kh = hitKnot(props, scale, pos, POINT_HIT_PX)
    if (kh) {
      const pc = props[kh.prop].curves[kh.curve]
      const srcIndex = pc.knots[kh.knot].srcIndex
      if (srcIndex >= 0) {
        startPointDrag(e, knotSel(pc, srcIndex))
        return
      }
    }
    // A curve line: cmd+click inserts, pencil draws, plain click selects.
    const ch = hitCurve(props, scale, pos, CURVE_HIT_PX)
    // Cmd+click inserts at the clicked time: on the curve under the cursor,
    // else anywhere in the editor on the selected curve (y is ignored).
    if (e.metaKey || e.ctrlKey) {
      const target = (ch != null ? props[ch] : undefined) ?? selectedCurve()
      if (target) addPointAt(target, pos)
      return
    }
    if (ch != null) {
      const p = props[ch]
      if (pencil) {
        // Pencil draws on the selected curve if any, else the one clicked.
        beginDraw(selectedCurve() ?? p, pos)
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      if (isDouble) return
      // Defer the toggle: a second press within the window cancels it.
      const key = p.key
      const additive = e.shiftKey
      const apply = (): void => selectProp(key, additive)
      pendingSel.current = {
        timer: window.setTimeout(() => {
          pendingSel.current = null
          apply()
        }, SELECT_DELAY_MS),
        x: pos.x,
        y: pos.y,
        apply
      }
      return
    }
    // Pencil: click & drag draws points onto the selected curve. With
    // nothing selected it falls through to the normal marquee behavior.
    const pt = pencil ? selectedCurve() : undefined
    if (pt) {
      beginDraw(pt, pos)
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    // Inside the transform box (with a little slop for degenerate boxes),
    // drag moves the whole selection; shift still rubber-bands additively.
    if (
      selBox &&
      !e.shiftKey &&
      pos.x >= selBox.x - 4 &&
      pos.x <= selBox.x + selBox.w + 4 &&
      pos.y >= selBox.y - 4 &&
      pos.y <= selBox.y + selBox.h + 4
    ) {
      beginXform(e, 'move', selBox)
      return
    }
    marquee.current = {
      x0: pos.x,
      y0: pos.y,
      base: e.shiftKey ? selectedPoints : [],
      moved: false,
      clear: !e.shiftKey
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  /** Double-click on a curve line inserts a point (points themselves win). */
  const onEditorDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (clips.length === 0) return
    // Cmd+dblclick: both presses already inserted via cmd+click.
    if (e.metaKey || e.ctrlKey) return
    const pos = svgPos(e)
    const props = interactiveProps()
    if (hitPoint(props, scale, pos, POINT_HIT_PX)) return
    if (hitKnot(props, scale, pos, POINT_HIT_PX)) return
    const ch = hitCurve(props, scale, pos, CURVE_HIT_PX)
    if (ch != null) addPointAt(props[ch], pos)
  }

  const onEditorMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const pos = svgPos(e)
    updateHover(pos)
    if (handleDrag.current) {
      onHandleMove(pos, e.shiftKey)
      return
    }
    if (drag.current) {
      onPointMove(e)
      return
    }
    if (draw.current) {
      if (Math.abs(pos.x - draw.current.lastX) >= DRAW_STEP_PX) drawAt(pos)
      return
    }
    if (xform.current) {
      applyXform(e)
      return
    }
    const m = marquee.current
    if (!m) return
    if (!m.moved && Math.abs(pos.x - m.x0) < 3 && Math.abs(pos.y - m.y0) < 3) return
    m.moved = true
    const rect = {
      x: Math.min(m.x0, pos.x),
      y: Math.min(m.y0, pos.y),
      w: Math.abs(pos.x - m.x0),
      h: Math.abs(pos.y - m.y0)
    }
    setMarqueeRect(rect)
    const seen = new Set(m.base.map(selKey))
    const hits = [...m.base]
    const consider = (px: number, py: number, sel: PointSel): void => {
      if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) return
      if (seen.has(selKey(sel))) return
      seen.add(selKey(sel))
      hits.push(sel)
    }
    for (const p of shown) {
      if (hidden.has(p.key) || dimmed(p.key)) continue
      for (const pt of p.points) consider(x(pt.t), y(p, pt.v), ptSel(pt))
      for (const pc of p.curves) {
        for (const k of pc.knots) {
          if (k.srcIndex >= 0) consider(x(k.t), y(p, k.v), knotSel(pc, k.srcIndex))
        }
      }
    }
    onSelectPoints(hits)
  }

  const onEditorUp = (): void => {
    const hd = handleDrag.current
    if (hd) {
      handleDrag.current = null
      // One undo entry per handle drag; a plain click on a handle is a noop.
      if (hd.last) onPointEdit([hd.last], true)
      return
    }
    if (drag.current) {
      onPointUp()
      return
    }
    if (draw.current) {
      endDraw()
      return
    }
    if (xform.current) {
      endXform(true)
      return
    }
    const m = marquee.current
    marquee.current = null
    setMarqueeRect(null)
    // A plain click on empty space clears both selections.
    if (m && !m.moved && m.clear) {
      onSelectPoints([])
      setSelectedProps(new Set())
    }
  }

  // Grid: vertical time lines for the shown range; horizontal value lines on
  // the selected curve's scale, else the first visible one (each curve
  // auto-scales its own Y, so the axis must follow what the user works on).
  const gridProp =
    shown.find((p) => selectedProps.has(p.key) && !hidden.has(p.key)) ??
    shown.find((p) => !hidden.has(p.key))
  const yGrid = ((): { py: number; label: string }[] => {
    if (clips.length === 0 || !gridProp || gridProp.max <= gridProp.min) return []
    const vStep = gridStep(gridProp.max - gridProp.min, innerH - 2 * PAD, 18)
    const vDec = stepDecimals(vStep)
    const out: { py: number; label: string }[] = []
    for (let i = Math.ceil(gridProp.min / vStep - 1e-6); i * vStep <= gridProp.max + 1e-6; i++) {
      out.push({ py: y(gridProp, i * vStep), label: (i * vStep).toFixed(vDec) })
    }
    return out
  })()
  const renderGrid = (): React.JSX.Element | null => {
    if (clips.length === 0) return null
    const lines: React.JSX.Element[] = []
    const tStep = gridStep(tRange, innerW - 2 * PAD, TIME_GRID_MIN_PX)
    for (let i = Math.ceil(tMin / tStep - 1e-6); i * tStep <= tMax + 1e-6; i++) {
      const px = x(i * tStep)
      lines.push(
        <line key={`t${i}`} x1={px} y1={0} x2={px} y2={innerH} className="curve-grid-line" />
      )
    }
    lines.push(
      ...yGrid.map(({ py }, i) => (
        <line key={`v${i}`} x1={0} y1={py} x2={innerW} y2={py} className="curve-grid-line" />
      ))
    )
    return <g className="curve-grid">{lines}</g>
  }

  const anyLoaded = clips.some((c) => loaded.has(c.path))

  // Seekbar: labels sit on the same grid as the vertical time lines; click
  // or drag seeks, clamped to the shown clips' span. Reads scrollLeft from
  // the DOM so a scrub mid-scroll never uses a stale offset.
  const rulerMarks = (): React.JSX.Element[] => {
    const tStep = gridStep(tRange, innerW - 2 * PAD, TIME_GRID_MIN_PX)
    const out: React.JSX.Element[] = []
    for (let i = Math.ceil(tMin / tStep - 1e-6); i * tStep <= tMax + 1e-6; i++) {
      const t = i * tStep
      out.push(
        <span key={i} className="curve-grid-label curve-ruler-mark" style={{ left: x(t) }}>
          {formatRulerLabel(t, tStep)}
        </span>
      )
    }
    return out
  }

  const seekAt = (e: React.PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const t = tAt(scale, e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0))
    onSeek(Math.min(Math.max(t, Math.max(tMin, 0)), tMax))
  }

  // Canvas painter: viewport-sized, devicePixelRatio-aware. Draws the
  // step-after lines and ALL points, translated by the scroll offsets and
  // culled to the visible time span. Runs after every render and on scroll.
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const paint = (): void => {
    const editor = editorRef.current
    const scroll = scrollRef.current
    const rect = editor?.getBoundingClientRect()
    const sl = scroll?.scrollLeft ?? 0
    const st = scroll?.scrollTop ?? 0
    const drawn = clips.length > 0 ? shown.filter((p) => !hidden.has(p.key)) : []
    // e2e hooks refresh even when the canvas isn't mounted (empty panel).
    window.__curveProps = drawn.map((p) => ({
      key: p.key,
      label: p.label,
      selected: selectedProps.has(p.key),
      dimmed: dimmed(p.key),
      pointCount: p.points.length,
      curveCount: p.curves.length
    }))
    window.__curvePoints = rect
      ? drawn
          .filter((p) => !dimmed(p.key))
          .flatMap((p) =>
            p.points.map((pt) => ({
              label: p.label,
              x: rect.left + x(pt.t) - sl,
              y: rect.top + y(p, pt.v) - st,
              selected: selKeys.has(selKey(ptSel(pt))),
              t: pt.t,
              v: pt.v
            }))
          )
      : []
    window.__curveKnots = rect
      ? drawn
          .filter((p) => !dimmed(p.key))
          .flatMap((p) =>
            p.curves.flatMap((pc) =>
              pc.knots.map((k) => ({
                label: p.label,
                x: rect.left + x(k.t) - sl,
                y: rect.top + y(p, k.v) - st,
                t: k.t,
                v: k.v,
                selected: k.srcIndex >= 0 && selKeys.has(selKey(knotSel(pc, k.srcIndex)))
              }))
            )
          )
      : []
    const canvas = canvasRef.current
    if (!canvas || w === 0 || h === 0) return
    const dpr = window.devicePixelRatio || 1
    const cw = Math.max(1, Math.round(w * dpr))
    const ch = Math.max(1, Math.round(h * dpr))
    if (canvas.width !== cw) canvas.width = cw
    if (canvas.height !== ch) canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.translate(-sl, -st)
    const t0 = tAt(scale, sl - PAD)
    const t1 = tAt(scale, sl + w + PAD)
    for (const p of drawn) {
      const dim = dimmed(p.key)
      ctx.globalAlpha = dim ? 0.1 : 1
      ctx.strokeStyle = p.color
      ctx.lineWidth = selectedProps.has(p.key) ? 3 : 1.5
      // One path per property: step-after lines and bezier spans merged.
      // The y map is affine, so mapping the control points maps the curve.
      ctx.beginPath()
      walkMerged(p, scale, t0, t1, {
        moveTo: (px, py) => ctx.moveTo(px, py),
        lineTo: (px, py) => ctx.lineTo(px, py),
        bezierTo: (x1, y1, x2, y2, x3, y3) => ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3)
      })
      ctx.stroke()
      if (dim) continue
      ctx.fillStyle = p.color
      const [lo, hi] = visibleRange(p.points, t0, t1)
      ctx.beginPath()
      for (let i = lo; i <= hi; i++) {
        const px = x(p.points[i].t)
        const py = y(p, p.points[i].v)
        ctx.moveTo(px + 3, py)
        ctx.arc(px, py, 3, 0, Math.PI * 2)
      }
      ctx.fill()
      // Knots draw as squares to read apart from points.
      ctx.beginPath()
      for (const pc of p.curves) {
        if (pc.knots[0].t > t1 || pc.knots[pc.knots.length - 1].t < t0) continue
        for (const k of pc.knots) {
          ctx.rect(x(k.t) - 3, y(p, k.v) - 3, 6, 6)
        }
      }
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
  const paintRef = useRef(paint)
  useEffect(() => {
    paintRef.current = paint
    paint()
  })

  return (
    <div className="curve-panel" style={{ height }}>
      <div className="curve-header">
        <button
          className={snap ? 'btn small snap active' : 'btn small snap'}
          data-tip="Snap"
          aria-label="snap"
          aria-pressed={snap}
          onClick={() => setSnap((s) => !s)}
        >
          <Magnet size={14} />
        </button>
        <button
          className={useBox ? 'btn small snap active' : 'btn small snap'}
          data-tip="Transform Box"
          aria-label="box"
          aria-pressed={useBox}
          onClick={() => setUseBox((b) => !b)}
        >
          <SquareDashed size={14} />
        </button>
        <button
          className={pencil ? 'btn small snap active' : 'btn small snap'}
          data-tip="Pencil tool"
          aria-label="pencil"
          aria-pressed={pencil}
          onClick={() => setPencil((p) => !p)}
        >
          <Pencil size={14} />
        </button>
        <button
          className="btn small snap"
          data-tip="Replace with Curve"
          aria-label="replace with curve"
          disabled={!canReplace}
          onClick={replaceWithCurve}
        >
          <Spline size={14} />
        </button>
        <div className="spacer" />
        <button
          className="btn small snap"
          data-tip="Fit zoom"
          aria-label="fit zoom"
          onClick={fitZoom}
        >
          <Maximize2 size={14} />
        </button>
        <span className="curve-zoom-label">X</span>
        <input
          className="zoom-slider curve-zoom"
          type="range"
          min={0}
          max={100}
          step={1}
          value={zoomToSlider(zoomX)}
          style={{ '--val': `${zoomToSlider(zoomX)}%` } as React.CSSProperties}
          aria-label="x zoom"
          onChange={(e) => setZoomX(sliderToZoom(Number(e.target.value)))}
        />
        <span className="curve-zoom-label">Y</span>
        <input
          className="zoom-slider curve-zoom"
          type="range"
          min={0}
          max={100}
          step={1}
          value={zoomToSlider(zoomY)}
          style={{ '--val': `${zoomToSlider(zoomY)}%` } as React.CSSProperties}
          aria-label="y zoom"
          onChange={(e) => setZoomY(sliderToZoom(Number(e.target.value)))}
        />
      </div>
      <div className="curve-body">
        <div className="curve-props">
          <input
            className="curve-filter"
            type="search"
            placeholder="filter"
            aria-label="filter properties"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {shown.map((p) => (
            <div
              className={selectedProps.has(p.key) ? 'curve-prop selected' : 'curve-prop'}
              key={p.key}
              onClick={(e) => selectProp(p.key, e.shiftKey)}
            >
              <input
                type="checkbox"
                checked={!hidden.has(p.key)}
                aria-label={`toggle ${p.label}`}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggle(p.key)}
              />
              <span className="curve-swatch" style={{ background: p.color }} />
              <span className="curve-prop-name">{p.label}</span>
            </div>
          ))}
          {clips.length > 0 && curves.length === 0 && anyLoaded && (
            <div className="curve-note">no numeric args</div>
          )}
        </div>
        <div className="curve-main">
          <div
            className="curve-ruler"
            onPointerDown={(e) => {
              if (e.button !== 0 || clips.length === 0) return
              e.currentTarget.setPointerCapture(e.pointerId)
              seekAt(e)
            }}
            onPointerMove={(e) => {
              if ((e.buttons & 1) === 0 || clips.length === 0) return
              seekAt(e)
            }}
          >
            {clips.length > 0 && w > 0 && (
              <div
                className="curve-ruler-content"
                style={{ width: innerW, transform: `translateX(${-scrollLeft}px)` }}
              >
                {rulerMarks()}
              </div>
            )}
          </div>
          <div
            className={pencil ? 'curve-editor pencil' : 'curve-editor'}
            ref={editorRef}
            onPointerDown={onEditorDown}
            onPointerMove={onEditorMove}
            onPointerUp={onEditorUp}
            // Cancel acts like release: point/xform drags commit their last
            // streamed values (never cancel-event coords), pencil commits its
            // batch, a marquee just closes.
            onPointerCancel={onEditorUp}
            onDoubleClick={onEditorDoubleClick}
            onPointerLeave={() => updateHover(null)}
          >
            {clips.length === 0 && (
              <div className="curve-empty">Select a clip to see its curves.</div>
            )}
            {clips.length > 0 && w > 0 && (
              <div
                className="curve-scroll"
                ref={scrollRef}
                onScroll={(e) => {
                  setScrollTop(e.currentTarget.scrollTop)
                  setScrollLeft(e.currentTarget.scrollLeft)
                  paintRef.current()
                }}
              >
                <div className="curve-content" style={{ width: innerW, height: innerH }}>
                  {/* Under-layer: grid + clip spans, below the curve canvas. */}
                  <svg className="curve-under" width={innerW} height={innerH}>
                    {renderGrid()}
                    {clips.length > 1 &&
                      clips.map((c) => {
                        const cx0 = x(c.offset)
                        const cw = Math.max(x(c.offset + clipLen(c)) - cx0, 1)
                        return (
                          // Faint span per clip so curves read against their source clips.
                          <g key={c.id} className="curve-clip-range">
                            <rect
                              className="curve-clip-fill"
                              x={cx0}
                              y={0}
                              width={cw}
                              height={innerH}
                            />
                            <rect className="curve-clip-bar" x={cx0} y={0} width={cw} height={3} />
                          </g>
                        )
                      })}
                  </svg>
                  {/* Over-layer: interactive/selected elements only — the point
                    cloud itself is painted on the canvas. */}
                  <svg className="curve-over" width={innerW} height={innerH}>
                    {interactiveProps().flatMap((p) =>
                      p.points
                        .filter((pt) => selKeys.has(selKey(ptSel(pt))))
                        .map((pt) => (
                          <circle
                            key={`${pt.clip.id}:${pt.eventIndex}:${pt.argIndex}`}
                            className="curve-point selected"
                            cx={x(pt.t)}
                            cy={y(p, pt.v)}
                            r={5}
                            fill={p.color}
                            stroke="#fff"
                            strokeWidth={1.5}
                          />
                        ))
                    )}
                    {interactiveProps().flatMap((p) =>
                      p.curves.flatMap((pc) =>
                        pc.knots
                          .filter(
                            (k) => k.srcIndex >= 0 && selKeys.has(selKey(knotSel(pc, k.srcIndex)))
                          )
                          .map((k) => (
                            <rect
                              key={`k${pc.clip.id}:${pc.curveIndex}:${k.srcIndex}`}
                              className="curve-knot selected"
                              x={x(k.t) - 4}
                              y={y(p, k.v) - 4}
                              width={8}
                              height={8}
                              fill={p.color}
                              stroke="#fff"
                              strokeWidth={1.5}
                            />
                          ))
                      )
                    )}
                    {handleViews().map((h) => (
                      <g
                        key={`h${h.pc.clip.id}:${h.pc.curveIndex}:${h.srcIndex}:${h.side}`}
                        className="curve-handle-g"
                      >
                        <line
                          className="curve-handle-line"
                          x1={h.kx}
                          y1={h.ky}
                          x2={h.hx}
                          y2={h.hy}
                        />
                        <circle
                          className={`curve-handle ${h.side === 'i' ? 'in' : 'out'}`}
                          cx={h.hx}
                          cy={h.hy}
                          r={4}
                          fill="#fff"
                          stroke={h.p.color}
                          strokeWidth={1.5}
                          onPointerDown={(e) => onHandleDown(e, h)}
                        />
                      </g>
                    ))}
                    {selBox && (
                      <g className="curve-xform">
                        <rect
                          className="curve-xform-box"
                          x={selBox.x}
                          y={selBox.y}
                          width={selBox.w}
                          height={selBox.h}
                        />
                        {(
                          [
                            { mode: 'left', x: selBox.x - 3, y: selBox.y, w: 6, h: selBox.h },
                            {
                              mode: 'right',
                              x: selBox.x + selBox.w - 3,
                              y: selBox.y,
                              w: 6,
                              h: selBox.h
                            },
                            { mode: 'top', x: selBox.x, y: selBox.y - 3, w: selBox.w, h: 6 },
                            {
                              mode: 'bottom',
                              x: selBox.x,
                              y: selBox.y + selBox.h - 3,
                              w: selBox.w,
                              h: 6
                            }
                          ] as const
                        ).map((s) => (
                          <rect
                            key={s.mode}
                            className={`curve-xform-edge ${s.mode}`}
                            x={s.x}
                            y={s.y}
                            width={s.w}
                            height={s.h}
                            onPointerDown={(e) => onEdgeDown(e, s.mode)}
                          />
                        ))}
                        {(
                          [
                            { k: 'l', x: selBox.x, y: selBox.y + selBox.h / 2 },
                            { k: 'r', x: selBox.x + selBox.w, y: selBox.y + selBox.h / 2 },
                            { k: 't', x: selBox.x + selBox.w / 2, y: selBox.y },
                            { k: 'b', x: selBox.x + selBox.w / 2, y: selBox.y + selBox.h }
                          ] as const
                        ).map((s) => (
                          <rect
                            key={s.k}
                            className="curve-xform-handle"
                            x={s.x - 3}
                            y={s.y - 3}
                            width={6}
                            height={6}
                          />
                        ))}
                      </g>
                    )}
                    <HoverTooltip subscribe={subscribeHover} />
                    {marqueeRect && (
                      <rect
                        className="curve-marquee"
                        x={marqueeRect.x}
                        y={marqueeRect.y}
                        width={marqueeRect.w}
                        height={marqueeRect.h}
                      />
                    )}
                  </svg>
                </div>
              </div>
            )}
            {clips.length > 0 && w > 0 && (
              <canvas className="curve-canvas" ref={canvasRef} style={{ width: w, height: h }} />
            )}
            {clips.length > 0 && w > 0 && yGrid.length > 0 && (
              <div className="curve-ylabels">
                {yGrid.map(({ py, label }, i) => (
                  <span
                    key={i}
                    className="curve-grid-label"
                    style={{ top: py - scrollTop, color: gridProp?.color }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
          {clips.length > 0 && w > 0 && (
            <CurvePlayhead
              playhead={playhead}
              playing={playing}
              toPx={(sec) => x(sec) - scrollLeft}
            />
          )}
        </div>
      </div>
    </div>
  )
}
