/** Canvas painter of the curve editor + the e2e geometry hooks. Viewport-
 *  sized, devicePixelRatio-aware: draws the step-after lines and ALL points,
 *  translated by the scroll offsets and culled to the visible time span. */
import { tAt, visibleRange, walkMerged, xAt, yAt, PAD, type Scale } from './curveGeom'
import { knotSel, ptSel, selKey, type Property } from './curveModel'

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

export interface PaintCtx {
  canvas: HTMLCanvasElement | null
  /** Bounding rect of .curve-editor; undefined before mount. */
  editorRect: DOMRect | undefined
  scrollLeft: number
  scrollTop: number
  w: number
  h: number
  scale: Scale
  /** Shown minus hidden; empty when no clips are selected. */
  drawn: Property[]
  dimmed: (key: string) => boolean
  selectedProps: Set<string>
  selKeys: Set<string>
}

export function paintCurves({
  canvas,
  editorRect: rect,
  scrollLeft: sl,
  scrollTop: st,
  w,
  h,
  scale,
  drawn,
  dimmed,
  selectedProps,
  selKeys
}: PaintCtx): void {
  const x = (t: number): number => xAt(scale, t)
  const y = (p: Property, v: number): number => yAt(scale, p, v)
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
