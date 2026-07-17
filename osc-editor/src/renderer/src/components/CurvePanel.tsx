import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { applyEditsIndexed } from '../../../shared/edits'
import type { ClipEdits, OscEvent } from '../../../shared/types'
import { ClipInst, clipLen } from '../timeline/model'
import { formatRulerLabel } from './Timeline'

const COLORS = [
  '#4da3ff',
  '#6fcf97',
  '#ffd24d',
  '#e5484d',
  '#c792ea',
  '#f78c6c',
  '#89ddff',
  '#f07178'
]
const PAD = 10

/** Candidate grid intervals; 0.1 for values, 1s for time at typical scales. */
const GRID_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120]

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

/** Clip files are immutable, so raw events cache forever. */
const eventsCache = new Map<string, OscEvent[]>()

interface CurvePoint {
  /** Timeline seconds (clip offset applied). */
  t: number
  v: number
  /** Event index in the original clip file (ClipEdits key). */
  eventIndex: number
  argIndex: number
  /** The clip instance this point came from (drives clamping + patches). */
  clip: ClipInst
}

interface Property {
  /** `${addr} ${argIndex}` — stable id, never shown. */
  key: string
  label: string
  color: string
  points: CurvePoint[]
  min: number
  max: number
}

function buildProperties(
  clipEvents: { clip: ClipInst; events: OscEvent[] }[],
  edits: Record<string, ClipEdits>
): Property[] {
  const byKey = new Map<string, CurvePoint[]>()
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
        pts.push({ t: clip.offset + (ev.t - clip.trimIn), v: arg, eventIndex: idx, argIndex, clip })
      })
    }
  }
  // Sort by address, then arg index, so the list order is stable and scannable.
  const sorted = [...byKey.entries()].sort(([a], [b]) => {
    const [aAddr, aIdx] = a.split(' ')
    const [bAddr, bIdx] = b.split(' ')
    return aAddr === bAddr ? Number(aIdx) - Number(bIdx) : aAddr < bAddr ? -1 : 1
  })
  return sorted.map(([key, points], i) => {
    points.sort((a, b) => a.t - b.t)
    const [addr, argIdx] = key.split(' ')
    const label = (argCount.get(addr) ?? 1) > 1 ? `${addr}[${argIdx}]` : addr
    let min = Infinity
    let max = -Infinity
    for (const p of points) {
      min = Math.min(min, p.v)
      max = Math.max(max, p.v)
    }
    return { key, label, color: COLORS[i % COLORS.length], points, min, max }
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

export interface PointSel {
  /** Clip file the event belongs to (ClipEdits key space). */
  file: string
  eventIndex: number
  argIndex: number
}

function selKey(s: PointSel): string {
  return `${s.file}:${s.eventIndex}:${s.argIndex}`
}

function ptSel(pt: CurvePoint): PointSel {
  return { file: pt.clip.file, eventIndex: pt.eventIndex, argIndex: pt.argIndex }
}

/** One numeric-arg edit: absolute clip-local t and/or value for args[argIndex]. */
export interface PointPatch {
  file: string
  eventIndex: number
  t?: number
  argIndex?: number
  value?: number
}

export function CurvePanel({
  clips,
  edits,
  height,
  selectedPoints,
  onSelectPoints,
  onPointEdit
}: {
  /** Every clip whose events are shown; empty shows the placeholder. */
  clips: ClipInst[]
  edits: Record<string, ClipEdits>
  /** Panel height, px (the splitter above drives it). */
  height: number
  selectedPoints: PointSel[]
  onSelectPoints: (pts: PointSel[]) => void
  /** Streams transient patches while dragging; isCommit on release. */
  onPointEdit: (patches: PointPatch[], isCommit: boolean) => void
}): React.JSX.Element {
  // Events per clip path; the cache never goes stale (files are immutable).
  const [loaded, setLoaded] = useState<Map<string, OscEvent[]>>(new Map())
  // Visibility is keyed by address, so it usefully carries across clip selections.
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  // Selected properties: their curves draw thicker and win the hover tooltip.
  const [selectedProps, setSelectedProps] = useState<Set<string>>(new Set())
  const editorRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const { w, h } = useSize(editorRef)

  // Pinch (ctrl+wheel) zooms the time axis; 1 = the time range fits the panel.
  const [zoomX, setZoomX] = useState(1)
  const innerW = w * zoomX
  // Normalized time position under the cursor at pinch start; scroll is
  // restored after the zoomed width renders so that point stays put.
  const pinchAnchor = useRef<{ norm: number; viewX: number } | null>(null)

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
      setZoomX((z) => Math.min(Math.max(z * Math.exp(-e.deltaY * 0.01), 1), 50))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = pinchAnchor.current
    if (!el || !a) return
    pinchAnchor.current = null
    el.scrollLeft = PAD + a.norm * (w * zoomX - 2 * PAD) - a.viewX
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
          .catch((): OscEvent[] => [])
          .then((events) => eventsCache.set(p, events))
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
  const curves = useMemo(() => {
    const ready = clips.flatMap((clip) => {
      const events = loaded.get(clip.path)
      return events ? [{ clip, events }] : []
    })
    return buildProperties(ready, edits)
  }, [clips, loaded, edits])

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

  const x = (t: number): number => PAD + ((t - tMin) / tRange) * (innerW - 2 * PAD)
  const y = (p: Property, v: number): number =>
    p.max === p.min ? h / 2 : PAD + (1 - (v - p.min) / (p.max - p.min)) * (h - 2 * PAD)

  const selKeys = useMemo(() => new Set(selectedPoints.map(selKey)), [selectedPoints])

  // Point drag moves every selected point by the same Δt / Δvalue (value in
  // each property's own scale). Horizontal = t (clamped to the point's own
  // clip span), vertical = value. Scales are frozen at drag start so the
  // growing min/max doesn't feed back.
  const drag = useRef<{
    targets: { pt: CurvePoint; min: number; max: number }[]
    startX: number
    startY: number
    moved: boolean
    last: PointPatch[] | null
  } | null>(null)

  const onPointDown = (e: React.PointerEvent<SVGCircleElement>, pt: CurvePoint): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const key = selKey(ptSel(pt))
    if (e.shiftKey) {
      // Shift toggles membership; no drag.
      onSelectPoints(
        selKeys.has(key)
          ? selectedPoints.filter((s) => selKey(s) !== key)
          : [...selectedPoints, ptSel(pt)]
      )
      return
    }
    // Grabbing an unselected point selects just it; a selected one drags the group.
    const sel = selKeys.has(key) ? selKeys : new Set([key])
    if (!selKeys.has(key)) onSelectPoints([ptSel(pt)])
    const targets: { pt: CurvePoint; min: number; max: number }[] = []
    for (const p of curves) {
      for (const cp of p.points) {
        if (sel.has(selKey(ptSel(cp)))) targets.push({ pt: cp, min: p.min, max: p.max })
      }
    }
    drag.current = { targets, startX: e.clientX, startY: e.clientY, moved: false, last: null }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointMove = (e: React.PointerEvent<SVGCircleElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    d.moved = true
    const dt = (dx / Math.max(innerW - 2 * PAD, 1)) * tRange
    d.last = d.targets.map(({ pt, min, max }) => {
      const c = pt.clip
      const tl = Math.min(Math.max(pt.t + dt, c.offset), c.offset + clipLen(c))
      return {
        file: c.file,
        eventIndex: pt.eventIndex,
        t: c.trimIn + (tl - c.offset),
        argIndex: pt.argIndex,
        value: pt.v + (-dy / Math.max(h - 2 * PAD, 1)) * (max - min || 1)
      }
    })
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

  // Bounding box of the drawn selected points (hidden/dimmed curves excluded).
  const selBox = ((): Box | null => {
    if (selectedPoints.length < 2 || clips.length === 0) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let n = 0
    for (const p of curves) {
      if (hidden.has(p.key) || dimmed(p.key)) continue
      for (const pt of p.points) {
        if (!selKeys.has(selKey(ptSel(pt)))) continue
        const px = x(pt.t)
        const py = y(p, pt.v)
        x0 = Math.min(x0, px)
        y0 = Math.min(y0, py)
        x1 = Math.max(x1, px)
        y1 = Math.max(y1, py)
        n++
      }
    }
    return n >= 2 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
  })()

  const xform = useRef<{
    mode: XformMode
    startX: number
    startY: number
    box0: Box
    targets: { pt: CurvePoint; min: number; max: number; px0: number; py0: number }[]
    moved: boolean
    last: PointPatch[] | null
  } | null>(null)

  const beginXform = (e: React.PointerEvent, mode: XformMode, box: Box): void => {
    const targets: { pt: CurvePoint; min: number; max: number; px0: number; py0: number }[] = []
    for (const p of curves) {
      if (hidden.has(p.key) || dimmed(p.key)) continue
      for (const pt of p.points) {
        if (!selKeys.has(selKey(ptSel(pt)))) continue
        targets.push({ pt, min: p.min, max: p.max, px0: x(pt.t), py0: y(p, pt.v) })
      }
    }
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
    d.last = d.targets.map(({ pt, min, max, px0, py0 }) => {
      const { nx, ny } = map(px0, py0)
      const c = pt.clip
      const t = tMin + ((nx - PAD) / Math.max(innerW - 2 * PAD, 1)) * tRange
      const tl = Math.min(Math.max(t, c.offset), c.offset + clipLen(c))
      return {
        file: c.file,
        eventIndex: pt.eventIndex,
        t: c.trimIn + (tl - c.offset),
        argIndex: pt.argIndex,
        value: pt.v + (-(ny - py0) / Math.max(h - 2 * PAD, 1)) * (max - min || 1)
      }
    })
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

  // Hover: the tooltip always shows the point nearest to the cursor (px
  // distance). Selected properties win; otherwise all visible points compete.
  // Positions resolve each render, so the tooltip tracks a dragged point.
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null)
  const hoverInfo = ((): { px: number; py: number; text: string } | null => {
    if (!mouse || clips.length === 0) return null
    const visible = curves.filter((p) => !hidden.has(p.key))
    const sel = visible.filter((p) => selectedProps.has(p.key))
    let best: { px: number; py: number; text: string } | null = null
    let bestD = Infinity
    for (const p of sel.length > 0 ? sel : visible) {
      for (const pt of p.points) {
        const px = x(pt.t)
        const py = y(p, pt.v)
        const d = (px - mouse.x) ** 2 + (py - mouse.y) ** 2
        if (d < bestD) {
          bestD = d
          best = { px, py, text: `${p.label}: ${fmt(pt.v)} @ ${fmt(pt.t)}s` }
        }
      }
    }
    return best
  })()

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

  /** Pointer position in svg coordinates (x follows the horizontal scroll). */
  const svgPos = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = editorRef.current!.getBoundingClientRect()
    return {
      x: e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0),
      y: e.clientY - rect.top
    }
  }

  const onEditorDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    if (clips.length === 0) {
      onSelectPoints([])
      return
    }
    const pos = svgPos(e)
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

  const onEditorMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const pos = svgPos(e)
    setMouse(pos)
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
    for (const p of curves) {
      if (hidden.has(p.key) || dimmed(p.key)) continue
      for (const pt of p.points) {
        const px = x(pt.t)
        const py = y(p, pt.v)
        if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) continue
        if (seen.has(selKey(ptSel(pt)))) continue
        seen.add(selKey(ptSel(pt)))
        hits.push(ptSel(pt))
      }
    }
    onSelectPoints(hits)
  }

  const onEditorUp = (): void => {
    if (xform.current) {
      endXform(true)
      return
    }
    const m = marquee.current
    marquee.current = null
    setMarqueeRect(null)
    if (m && !m.moved && m.clear) onSelectPoints([])
  }

  // Grid: vertical time lines for the shown range; horizontal value lines on
  // the first visible curve's scale (each curve auto-scales its own Y).
  const gridProp = curves.find((p) => !hidden.has(p.key))
  const yGrid = ((): { py: number; label: string }[] => {
    if (clips.length === 0 || !gridProp || gridProp.max <= gridProp.min) return []
    const vStep = gridStep(gridProp.max - gridProp.min, h - 2 * PAD, 18)
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
    const tStep = gridStep(tRange, innerW - 2 * PAD, 50)
    for (let i = Math.ceil(tMin / tStep - 1e-6); i * tStep <= tMax + 1e-6; i++) {
      const t = i * tStep
      const px = x(t)
      lines.push(
        <line key={`t${i}`} x1={px} y1={0} x2={px} y2={h} className="curve-grid-line" />,
        // Top-aligned, ruler-style labels — same format as the timeline seekbar.
        <text key={`tl${i}`} x={px + 4} y={13} className="curve-grid-label" fill="#8b919c">
          {formatRulerLabel(t)}
        </text>
      )
    }
    lines.push(
      ...yGrid.map(({ py }, i) => (
        <line key={`v${i}`} x1={0} y1={py} x2={innerW} y2={py} className="curve-grid-line" />
      ))
    )
    return <g className="curve-grid">{lines}</g>
  }

  /** Step-after: an OSC value holds until the next message. */
  const stepPoints = (p: Property): string => {
    const parts: string[] = []
    p.points.forEach((pt, i) => {
      if (i > 0) parts.push(`${x(pt.t)},${y(p, p.points[i - 1].v)}`)
      parts.push(`${x(pt.t)},${y(p, pt.v)}`)
    })
    return parts.join(' ')
  }

  const anyLoaded = clips.some((c) => loaded.has(c.path))

  return (
    <div className="curve-panel" style={{ height }}>
      <div className="curve-props">
        {curves.map((p) => (
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
      <div
        className="curve-editor"
        ref={editorRef}
        onPointerDown={onEditorDown}
        onPointerMove={onEditorMove}
        onPointerUp={onEditorUp}
        onPointerLeave={() => setMouse(null)}
      >
        {clips.length === 0 && <div className="curve-empty">Select a clip to see its curves.</div>}
        {clips.length > 0 && w > 0 && (
          <div className="curve-scroll" ref={scrollRef}>
            <svg width={innerW} height={h}>
              {renderGrid()}
              {curves
                .filter((p) => !hidden.has(p.key))
                .map((p) => (
                  <g key={p.key} data-prop={p.label} opacity={dimmed(p.key) ? 0.1 : 1}>
                    <polyline
                      data-prop={p.label}
                      points={stepPoints(p)}
                      fill="none"
                      stroke={p.color}
                      strokeWidth={selectedProps.has(p.key) ? 3 : 1.5}
                    />
                    {!dimmed(p.key) &&
                      p.points.map((pt) => {
                        const selected = selKeys.has(selKey(ptSel(pt)))
                        return (
                          <circle
                            key={`${pt.clip.id}:${pt.eventIndex}:${pt.argIndex}`}
                            className={selected ? 'curve-point selected' : 'curve-point'}
                            cx={x(pt.t)}
                            cy={y(p, pt.v)}
                            r={selected ? 5 : 3}
                            fill={p.color}
                            stroke={selected ? '#fff' : 'none'}
                            strokeWidth={selected ? 1.5 : 0}
                            onPointerDown={(e) => onPointDown(e, pt)}
                            onPointerMove={onPointMove}
                            onPointerUp={onPointUp}
                          />
                        )
                      })}
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
                      { mode: 'right', x: selBox.x + selBox.w - 3, y: selBox.y, w: 6, h: selBox.h },
                      { mode: 'top', x: selBox.x, y: selBox.y - 3, w: selBox.w, h: 6 },
                      { mode: 'bottom', x: selBox.x, y: selBox.y + selBox.h - 3, w: selBox.w, h: 6 }
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
              {hoverInfo && (
                <text
                  className="curve-tooltip"
                  x={hoverInfo.px + 8}
                  y={hoverInfo.py - 8}
                  textAnchor={hoverInfo.px > innerW - 120 ? 'end' : 'start'}
                >
                  {hoverInfo.text}
                </text>
              )}
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
        )}
        {clips.length > 0 && w > 0 && yGrid.length > 0 && (
          <div className="curve-ylabels">
            {yGrid.map(({ py, label }, i) => (
              <span
                key={i}
                className="curve-grid-label"
                style={{ top: py, color: gridProp?.color }}
              >
                {label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
