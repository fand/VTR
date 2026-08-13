import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Brackets, Magnet, Maximize2, Pencil, Spline, SquareDashed } from 'lucide-react'
import type { ClipCurve, ClipEdits, OscEvent } from '../../../shared/types'
import {
  ClipInst,
  clipLen,
  formatRulerLabel,
  gridStep,
  stepDecimals,
  TIME_TICK_MIN_PX
} from '../timeline/model'
import { applyEditsIndexed } from '../../../shared/edits'
import type { EventPointSel } from '../../../shared/edits'
import { buildPointConversion, type ConvertCtx, type ConvertResult } from './curveConvert'
import { MIN_FIT_POINTS, buildCurveReplace } from './curveReplace'
import { PAD, fitZoomX, tAt, xAt, yAt, type Scale } from './curveGeom'
import {
  buildProperties,
  fmt,
  forEachEl,
  MAX_ZOOM,
  ptSel,
  selKey,
  type CurvePoint,
  type PointAdd,
  type PointPatch,
  type PointSel,
  type PropCurve,
  type Property
} from './curveModel'
import { MODES, MODE_LABELS, selectionMode, type InterpMode } from './curveMode'
import { paintCurves } from './curvePaint'
import { zoomSlider } from './uiScale'
import { useCurveInteraction } from './useCurveInteraction'
import { useCurveViewport } from './useCurveViewport'
import { eventsCache } from './eventsCache'
import type { PlayingState } from './Timeline'

// Moved to curveModel.ts; re-exported so App.tsx keeps one import site.
export type {
  CurvePatch,
  EventPatch,
  EventPointSel,
  KnotSel,
  PointAdd,
  PointPatch,
  PointSel
} from './curveModel'

/** Y slider maps 0..100 onto 1..MAX_ZOOM; the X slider's ceiling is dynamic
 *  (vp.zoomXMax), so its mapping is built per render. */
const zoomYMap = zoomSlider(1, MAX_ZOOM)

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

/** Value editor for the point selection: the value they all share, `-` when
 *  they differ. Enter/blur commits it to every selected point, Esc reverts.
 *  The 0–1 limit toggle doesn't apply — explicit typing beats a drag guard. */
function ValueField({
  value,
  onCommit
}: {
  value: number | null
  onCommit: (v: number) => void
}): React.JSX.Element {
  const text = value == null ? '' : fmt(value)
  const [draft, setDraft] = useState(text)
  useEffect(() => setDraft(text), [text])
  // Esc blurs too, so the blur handler must know not to commit the draft.
  const reverting = useRef(false)
  const commit = (): void => {
    const n = Number(draft)
    if (draft.trim() !== '' && Number.isFinite(n) && n !== value) onCommit(n)
    else setDraft(text)
  }
  return (
    <label className="port-field curve-field">
      <span className="port-field-label">value</span>
      <input
        value={draft}
        placeholder="-"
        inputMode="numeric"
        aria-label="point value"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!reverting.current) commit()
          else {
            reverting.current = false
            setDraft(text)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            reverting.current = true
            e.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

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
  onCurveReplace,
  onInterpolate
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
  /** Streams transient patches while dragging; isCommit on release. The
   *  label names the commit's undo entry (default: "N points edited"). */
  onPointEdit: (patches: PointPatch[], isCommit: boolean, label?: string) => void
  /** Appends events to the clips' edit overlays. A pencil stroke streams
   *  single adds (transient) and re-sends the whole batch with isCommit. */
  onPointAdd: (adds: PointAdd[], isCommit: boolean) => void
  /** Replaces points atomically: one undo entry for the deletes + curve adds. */
  onCurveReplace: (
    dels: { file: string; eventIndex: number }[],
    adds: { file: string; curve: ClipCurve }[]
  ) => void
  /** Sets the interpolation of every selected point; one undo entry. The
   *  conversion carries the selected event points' curves (null when none
   *  are selected), so knot modes and conversions commit together. */
  onInterpolate: (mode: InterpMode, convert: ConvertResult | null) => void
}): React.JSX.Element {
  // Events per clip path; the cache never goes stale (files are immutable).
  const [loaded, setLoaded] = useState<Map<string, OscEvent[]>>(new Map())
  // Visibility is keyed by address, so it usefully carries across clip selections.
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  // Name filter: narrows the property list and the drawn curves.
  const [filter, setFilter] = useState('')
  // Header toggles: snap point edits to the grid; limit dragged values to
  // 0..1; show the transform box; pencil (clicks add points to the selected
  // curve).
  const [snap, setSnap] = useState(false)
  const [limit, setLimit] = useState(false)
  const [useBox, setUseBox] = useState(true)
  const [pencil, setPencil] = useState(false)
  // Selected properties: their curves draw thicker and win the hover tooltip.
  const [selectedProps, setSelectedProps] = useState<Set<string>>(new Set())
  // Time domain: the union of the shown clips' timeline spans.
  const tMin = clips.length > 0 ? Math.min(...clips.map((c) => c.offset)) : 0
  const tMax = clips.length > 0 ? Math.max(...clips.map((c) => c.offset + clipLen(c))) : 0
  const tRange = Math.max(tMax - tMin, 1e-9)

  const editorRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const vp = useCurveViewport(editorRef, scrollRef, tRange)
  const { w, h, zoomX, zoomY, innerW, innerH, scrollTop, scrollLeft } = vp
  const zoomXMap = zoomSlider(1, vp.zoomXMax)

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

  const scale: Scale = { tMin, tRange, innerW, innerH }
  const x = (t: number): number => xAt(scale, t)
  const y = (p: Property, v: number): number => yAt(scale, p, v)

  const selKeys = useMemo(() => new Set(selectedPoints.map(selKey)), [selectedPoints])

  // Header editors work on the whole point selection — event points and
  // knots alike — so they read and write through the one traversal.
  const selValues = ((): number[] => {
    if (selectedPoints.length === 0) return []
    const out: number[] = []
    forEachEl(curves, (el) => {
      if (el.sel && selKeys.has(selKey(el.sel))) out.push(el.v)
    })
    return out
  })()
  const selValue =
    selValues.length > 0 && selValues.every((v) => v === selValues[0]) ? selValues[0] : null
  const selMode = selectionMode(selectedPoints, edits)
  const pointSels = selectedPoints.filter((s): s is EventPointSel => !('curveIndex' in s))

  // Conversion context: every event and live overlay curve of the shown
  // files. Trim doesn't narrow it — the overlay is per file, so an event
  // outside this clip's window still plays through another instance of it,
  // and the span invariant has to hold there too.
  const convertCtx = useMemo((): ConvertCtx => {
    const events: ConvertCtx['events'] = []
    const list: ConvertCtx['curves'] = []
    const seen = new Set<string>()
    for (const clip of clips) {
      const evs = loaded.get(clip.path)
      if (!evs || seen.has(clip.file)) continue
      seen.add(clip.file)
      const clipEdits = edits[clip.file]
      for (const { ev, idx } of applyEditsIndexed(evs, clipEdits)) {
        events.push({ file: clip.file, eventIndex: idx, ev })
      }
      clipEdits?.curves?.forEach((c, ci) => {
        if (!clipEdits.curveDel?.[ci]) list.push({ file: clip.file, curveIndex: ci, curve: c })
      })
    }
    return { events, curves: list }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clipsKey covers clips
  }, [clipsKey, loaded, edits])

  // Whether the selected points can become knots at all is structural (a
  // lone point with no neighbor element can't), so one mode probes for all.
  const canConvert = useMemo(
    () =>
      pointSels.length > 0 && buildPointConversion(pointSels, convertCtx, 'ease-in-out') != null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedPoints covers pointSels
    [selectedPoints, convertCtx]
  )

  /** Typed value → patches: event points patch their arg, knots chain into
   *  one whole-array patch per curve (per-knot patches would overwrite each
   *  other — same rule as movePatches in useCurveInteraction). Handle
   *  offsets are relative, so they carry over untouched. */
  const setSelectedValue = (v: number): void => {
    const out: PointPatch[] = []
    const byCurve = new Map<string, { pc: PropCurve; idx: Set<number> }>()
    forEachEl(curves, (el) => {
      if (!el.sel || !selKeys.has(selKey(el.sel))) return
      if (el.pt) {
        out.push({
          file: el.pt.clip.file,
          eventIndex: el.pt.eventIndex,
          argIndex: el.pt.argIndex,
          value: v
        })
        return
      }
      const pc = el.pc!
      const key = `${pc.clip.file}:${pc.curveIndex}`
      let g = byCurve.get(key)
      if (!g) byCurve.set(key, (g = { pc, idx: new Set() }))
      g.idx.add(el.srcIndex!)
    })
    for (const { pc, idx } of byCurve.values()) {
      out.push({
        file: pc.clip.file,
        curveIndex: pc.curveIndex,
        knots: pc.src.knots.map((k, i) => (idx.has(i) ? { ...k, v } : k))
      })
    }
    if (out.length > 0) onPointEdit(out, true, 'value edit')
  }

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

  // Snap on: dragged times/values lock onto the same grid the editor draws.
  const snapTime = (t: number): number => {
    if (!snap) return t
    const step = gridStep(tRange, innerW - 2 * PAD, TIME_TICK_MIN_PX)
    return Math.round(t / step) * step
  }
  const snapValue = (v: number, min: number, max: number): number => {
    if (!snap || max <= min) return v
    const step = gridStep(max - min, innerH - 2 * PAD, 18)
    return Math.round(v / step) * step
  }
  // Limit on: dragged values clamp to 0..1. Points that started outside the
  // range are left alone (v0 is the drag-start value).
  const limitValue = (v: number, v0: number): number => {
    if (!limit || v0 < 0 || v0 > 1) return v
    return Math.min(Math.max(v, 0), 1)
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
    forEachEl(sel.length > 0 ? sel : visible, (el) => {
      const px = x(el.t)
      const py = y(el.p, el.v)
      const d = (px - mouse.x) ** 2 + (py - mouse.y) ** 2
      if (d < bestD) {
        bestD = d
        best = {
          px,
          py,
          anchor: px > innerW - 120 ? 'end' : 'start',
          text: `${el.p.label}: ${fmt(el.v)} @ ${fmt(el.t)}s`
        }
      }
    })
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

  const ia = useCurveInteraction({
    clips,
    edits,
    curves,
    shown,
    hidden,
    dimmed,
    selectedProps,
    selectProp,
    setSelectedProps,
    selectedPoints,
    selKeys,
    onSelectPoints,
    onPointEdit,
    onPointAdd,
    scale,
    tRange,
    innerW,
    innerH,
    snapTime,
    snapValue,
    limitValue,
    loaded,
    pencil,
    useBox,
    editorRef,
    scrollRef,
    updateHover
  })
  const { selBox, marqueeRect } = ia

  // Fit the X zoom to the selected points, else the selected curves (via
  // dimmed()), else everything shown. Vertical zoom stays put.
  const fitZoom = (): void => {
    const span = (usePointSel: boolean): [number, number] => {
      let t0 = Infinity
      let t1 = -Infinity
      forEachEl(ia.interactiveProps(), (el) => {
        if (usePointSel && !(el.sel && selKeys.has(selKey(el.sel)))) return
        t0 = Math.min(t0, el.t)
        t1 = Math.max(t1, el.t)
      })
      return [t0, t1]
    }
    let [t0, t1] = span(selKeys.size > 0)
    // Selected points all on hidden/dimmed curves: fit the visible ones.
    if (t1 < t0 && selKeys.size > 0) [t0, t1] = span(false)
    if (t1 < t0) return // nothing to fit
    const fit = fitZoomX(w, tMin, tRange, t0, t1, vp.zoomXMax)
    if (fit) vp.applyFit(fit)
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
    const tStep = gridStep(tRange, innerW - 2 * PAD, TIME_TICK_MIN_PX)
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
    const tStep = gridStep(tRange, innerW - 2 * PAD, TIME_TICK_MIN_PX)
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

  // Canvas painter runs after every render and on scroll.
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const paint = (): void => {
    paintCurves({
      canvas: canvasRef.current,
      editorRect: editorRef.current?.getBoundingClientRect(),
      scrollLeft: scrollRef.current?.scrollLeft ?? 0,
      scrollTop: scrollRef.current?.scrollTop ?? 0,
      w,
      h,
      scale,
      drawn: clips.length > 0 ? shown.filter((p) => !hidden.has(p.key)) : [],
      dimmed,
      selectedProps,
      selKeys
    })
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
          className={limit ? 'btn small snap active' : 'btn small snap'}
          data-tip="Limit values to 0–1"
          aria-label="limit"
          aria-pressed={limit}
          onClick={() => setLimit((l) => !l)}
        >
          <Brackets size={14} />
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
        {selectedPoints.length > 0 && (
          <>
            <ValueField value={selValue} onCommit={setSelectedValue} />
            <label className="port-field curve-field">
              <span className="port-field-label">interpolate</span>
              <select
                className="curve-interp"
                aria-label="interpolation"
                value={selMode ?? ''}
                onChange={(e) => {
                  const m = e.target.value as InterpMode
                  onInterpolate(
                    m,
                    pointSels.length > 0 ? buildPointConversion(pointSels, convertCtx, m) : null
                  )
                }}
              >
                {/* Mixed selection: no mode is current until one is picked. */}
                {selMode == null && (
                  <option value="" disabled>
                    -
                  </option>
                )}
                {/* Points convert into knots; ones with no neighbor element
                    to interpolate with can only stay const. */}
                {MODES.map((m) => (
                  <option
                    key={m}
                    value={m}
                    disabled={pointSels.length > 0 && !canConvert && m !== 'const'}
                  >
                    {MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
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
          value={zoomXMap.toSlider(zoomX)}
          style={{ '--val': `${zoomXMap.toSlider(zoomX)}%` } as React.CSSProperties}
          aria-label="x zoom"
          onChange={(e) => vp.setZoomX(zoomXMap.fromSlider(Number(e.target.value)))}
        />
        <span className="curve-zoom-label">Y</span>
        <input
          className="zoom-slider curve-zoom"
          type="range"
          min={0}
          max={100}
          step={1}
          value={zoomYMap.toSlider(zoomY)}
          style={{ '--val': `${zoomYMap.toSlider(zoomY)}%` } as React.CSSProperties}
          aria-label="y zoom"
          onChange={(e) => vp.setZoomY(zoomYMap.fromSlider(Number(e.target.value)))}
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
            onPointerDown={ia.onEditorDown}
            onPointerMove={ia.onEditorMove}
            onPointerUp={ia.onEditorUp}
            // Cancel acts like release: point/xform drags commit their last
            // streamed values (never cancel-event coords), pencil commits its
            // batch, a marquee just closes.
            onPointerCancel={ia.onEditorUp}
            onDoubleClick={ia.onEditorDoubleClick}
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
                  vp.handleScroll(e.currentTarget)
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
                    {ia
                      .interactiveProps()
                      .flatMap((p) =>
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
                    {ia.interactiveProps().flatMap((p) =>
                      p.curves.flatMap((pc) =>
                        pc.knots
                          .filter(
                            (k) =>
                              k.srcIndex >= 0 &&
                              selKeys.has(
                                selKey({
                                  file: pc.clip.file,
                                  curveIndex: pc.curveIndex,
                                  knotIndex: k.srcIndex
                                })
                              )
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
                    {ia.handleViews().map((h) => (
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
                          onPointerDown={(e) => ia.onHandleDown(e, h)}
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
                            onPointerDown={(e) => ia.onEdgeDown(e, s.mode)}
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
