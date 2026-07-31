/** Pointer interaction of the curve editor: point/knot drags, the transform
 *  box, bezier handle drags, the pencil tool, point inserts, the deferred
 *  curve-select toggle, and the marquee. Moved verbatim from CurvePanel; the
 *  hook re-runs every render, so everything here closes over the caller's
 *  fresh ctx exactly like the original inline closures did. Only the refs
 *  (drag state machines) persist across renders. */
import React, { useRef, useState } from 'react'
import type { ClipEdits, OscEvent } from '../../../shared/types'
import { clipLen, type ClipInst } from '../timeline/model'
import { applyKnotMoves, setKnotHandle } from './curveEdit'
import {
  PAD,
  hitCurve,
  hitKnot,
  hitPoint,
  mergedValueAt,
  tAt,
  vAt,
  xAt,
  yAt,
  type Scale
} from './curveGeom'
import {
  forEachEl,
  knotSel,
  ptSel,
  selKey,
  type CurvePatch,
  type CurvePoint,
  type PointAdd,
  type PointPatch,
  type PointSel,
  type PropCurve,
  type Property
} from './curveModel'

/** Hit radii, px: points win over curve lines (the old SVG stacking order). */
const POINT_HIT_PX = 6
const CURVE_HIT_PX = 5
/** Horizontal travel between points added by a pencil-drag stroke. */
const DRAW_STEP_PX = 4

// Drag targets: discrete points and bezier knots move under the same
// rules. Positions and value scales are frozen at drag start so the
// streaming edits don't feed back; knots keep a handle on the frozen
// overlay record (src) so each move rebuilds the whole knot array from it.
type DragTarget =
  | { pt: CurvePoint; min: number; max: number }
  | { pc: PropCurve; srcIndex: number; t: number; v: number; min: number; max: number }

type XformMode = 'move' | 'left' | 'right' | 'top' | 'bottom'
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Bezier handle view: every selected knot's incoming/outgoing handle. */
export interface HandleView {
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

export interface CurveInteractionCtx {
  clips: ClipInst[]
  edits: Record<string, ClipEdits>
  /** All properties (dragTargets works off the full set). */
  curves: Property[]
  /** Filter-passing properties (marquee + selection-driven queries). */
  shown: Property[]
  hidden: Set<string>
  dimmed: (key: string) => boolean
  selectedProps: Set<string>
  selectProp: (key: string, additive: boolean) => void
  setSelectedProps: (next: Set<string>) => void
  selectedPoints: PointSel[]
  selKeys: Set<string>
  onSelectPoints: (pts: PointSel[]) => void
  onPointEdit: (patches: PointPatch[], isCommit: boolean) => void
  onPointAdd: (adds: PointAdd[], isCommit: boolean) => void
  scale: Scale
  tRange: number
  innerW: number
  innerH: number
  snapTime: (t: number) => number
  snapValue: (v: number, min: number, max: number) => number
  loaded: Map<string, OscEvent[]>
  pencil: boolean
  useBox: boolean
  editorRef: React.RefObject<HTMLDivElement | null>
  scrollRef: React.RefObject<HTMLDivElement | null>
  updateHover: (pos: { x: number; y: number } | null) => void
}

export interface CurveInteraction {
  onEditorDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onEditorMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onEditorUp: () => void
  onEditorDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => void
  onEdgeDown: (e: React.PointerEvent<SVGRectElement>, mode: XformMode) => void
  onHandleDown: (e: React.PointerEvent<SVGCircleElement>, h: HandleView) => void
  marqueeRect: Box | null
  selBox: Box | null
  handleViews: () => HandleView[]
  interactiveProps: () => Property[]
}

export function useCurveInteraction(ctx: CurveInteractionCtx): CurveInteraction {
  const {
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
    loaded,
    pencil,
    useBox,
    editorRef,
    scrollRef,
    updateHover
  } = ctx

  const x = (t: number): number => xAt(scale, t)
  const y = (p: Property, v: number): number => yAt(scale, p, v)

  /** Curves that take pointer hits. Declared here because selBox reads it
   *  during render, before the handlers below are defined. */
  const interactiveProps = (): Property[] =>
    shown.filter((p) => !hidden.has(p.key) && !dimmed(p.key))

  /** A target's frozen timeline position + value scale. */
  const targetPos = (target: DragTarget): { t: number; v: number; min: number; max: number } =>
    'pt' in target ? { t: target.pt.t, v: target.pt.v, min: target.min, max: target.max } : target

  /** Every drawn point/knot in the given selection (drag/xform group). */
  const dragTargets = (sel: Set<string>): DragTarget[] => {
    const targets: DragTarget[] = []
    forEachEl(curves, (el) => {
      if (!el.sel || !sel.has(selKey(el.sel))) return
      if (el.pt) targets.push({ pt: el.pt, min: el.p.min, max: el.p.max })
      else {
        targets.push({
          pc: el.pc!,
          srcIndex: el.srcIndex!,
          t: el.t,
          v: el.v,
          min: el.p.min,
          max: el.p.max
        })
      }
    })
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

  /** Drawn selected points + knots (hidden/dimmed curves excluded), with
   *  their frozen pixel positions. Feeds the box bounds and xform targets. */
  const drawnSelected = (): (DragTarget & { px0: number; py0: number })[] => {
    const out: (DragTarget & { px0: number; py0: number })[] = []
    forEachEl(interactiveProps(), (el) => {
      if (!el.sel || !selKeys.has(selKey(el.sel))) return
      if (el.pt) {
        out.push({ pt: el.pt, min: el.p.min, max: el.p.max, px0: x(el.t), py0: y(el.p, el.v) })
      } else {
        out.push({
          pc: el.pc!,
          srcIndex: el.srcIndex!,
          t: el.t,
          v: el.v,
          min: el.p.min,
          max: el.p.max,
          px0: x(el.t),
          py0: y(el.p, el.v)
        })
      }
    })
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
    // The time scale clamps at zero width: dragging past the anchor would
    // reverse knot order, which applyKnotMoves resolves by piling the knots
    // at the anchor (its order invariant), not mirroring — destructive.
    // Value flips stay allowed; values carry no order invariant.
    const map = (px: number, py: number): { nx: number; ny: number } => {
      switch (d.mode) {
        case 'move':
          return { nx: px + dx, ny: py + dy }
        case 'left':
          return {
            nx: b.w > 0 ? b.x + b.w - ((b.x + b.w - px) * Math.max(b.w - dx, 0)) / b.w : px,
            ny: py
          }
        case 'right':
          return { nx: b.w > 0 ? b.x + ((px - b.x) * Math.max(b.w + dx, 0)) / b.w : px, ny: py }
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
  const handleViews = (): HandleView[] => {
    if (clips.length === 0) return []
    const out: HandleView[] = []
    forEachEl(interactiveProps(), (el) => {
      if (!el.pc || el.srcIndex == null || el.srcIndex < 0) return
      if (!el.sel || !selKeys.has(selKey(el.sel))) return
      const { p, pc } = el
      const kn = pc.src.knots
      const i = el.srcIndex
      const mk = (side: 'i' | 'o', dt: number, dv: number): void => {
        out.push({
          p,
          pc,
          srcIndex: i,
          side,
          kt: el.t,
          kv: el.v,
          kx: x(el.t),
          ky: y(p, el.v),
          hx: x(el.t + dt),
          hy: y(p, el.v + dv)
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
    })
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

  // Marquee: drag on empty editor space rubber-bands a selection. A plain
  // click (< 3px) clears it, matching the old deselect behavior.
  const marquee = useRef<{
    x0: number
    y0: number
    base: PointSel[]
    moved: boolean
    clear: boolean
  } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<Box | null>(null)

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
    if (p.points.length === 0 && p.curves.length === 0) return null
    const t = snapTime(tAt(scale, pos.x))
    const v = onCurve ? (mergedValueAt(p, t) ?? 0) : snapValue(vAt(scale, p, pos.y), p.min, p.max)
    // Template: the nearest point's event; on a fully-replaced property the
    // nearest curve's message template.
    let tpl: CurvePoint | null = null
    for (const pt of p.points) {
      if (!tpl || Math.abs(pt.t - t) < Math.abs(tpl.t - t)) tpl = pt
    }
    let src: {
      clip: ClipInst
      port: number
      a: string
      types?: string
      args: unknown[]
      argIndex: number
    }
    if (tpl) {
      src = {
        clip: tpl.clip,
        port: tpl.ev.port,
        a: tpl.ev.a,
        types: tpl.ev.types,
        args: tpl.ev.args,
        argIndex: tpl.argIndex
      }
    } else {
      let pc = p.curves[0]
      const dist = (c: PropCurve): number =>
        Math.max(c.knots[0].t - t, 0, t - c.knots[c.knots.length - 1].t)
      for (const c of p.curves) {
        if (dist(c) < dist(pc)) pc = c
      }
      src = {
        clip: pc.clip,
        port: pc.src.port,
        a: pc.src.a,
        types: pc.src.types,
        args: pc.src.args,
        argIndex: pc.src.arg
      }
    }
    const c = src.clip
    const events = loaded.get(c.path)
    if (!events) return null
    const tl = Math.min(Math.max(t, c.offset), c.offset + clipLen(c))
    const args = [...src.args]
    args[src.argIndex] = v
    return {
      sel: {
        file: c.file,
        eventIndex: events.length + addCount(c.file),
        argIndex: src.argIndex
      },
      // Same arg count as the template, so its type tags still apply. Without
      // them the player guesses, and an `i`-tagged arg would replay as f32.
      ev: { t: c.trimIn + (tl - c.offset), port: src.port, a: src.a, types: src.types, args }
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
    forEachEl(interactiveProps(), (el) => {
      if (!el.sel) return
      const px = x(el.t)
      const py = y(el.p, el.v)
      if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) return
      if (seen.has(selKey(el.sel))) return
      seen.add(selKey(el.sel))
      hits.push(el.sel)
    })
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

  return {
    onEditorDown,
    onEditorMove,
    onEditorUp,
    onEditorDoubleClick,
    onEdgeDown,
    onHandleDown,
    marqueeRect,
    selBox,
    handleViews,
    interactiveProps
  }
}
