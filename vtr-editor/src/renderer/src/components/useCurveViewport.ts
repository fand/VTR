/** Viewport state of the curve editor: element size, X/Y zoom, scroll
 *  offsets, ctrl+wheel pinch (anchored under the cursor), and fit-zoom
 *  scroll application. Owns the frame-timing workarounds; see the comments
 *  on pinchAnchor/zoomXRef. */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PAD } from './curveGeom'
import { maxZoomX } from './curveModel'
import { useElementSize } from './uiScale'

export interface CurveViewport {
  w: number
  h: number
  zoomX: number
  zoomY: number
  /** Current X-zoom ceiling; grows with the shown time range (frame-level max). */
  zoomXMax: number
  setZoomX: (z: number) => void
  setZoomY: (z: number) => void
  innerW: number
  innerH: number
  scrollTop: number
  scrollLeft: number
  setScrollLeft: (px: number) => void
  /** onScroll of .curve-scroll: mirror the offsets into state. */
  handleScroll: (el: HTMLDivElement) => void
  /** Apply a fitZoomX result: re-render at the new zoom with the scroll set
   *  before paint, or scroll directly when the zoom is unchanged. */
  applyFit: (fit: { zoomX: number; scrollLeft: number }) => void
}

export function useCurveViewport(
  editorRef: React.RefObject<HTMLDivElement | null>,
  scrollRef: React.RefObject<HTMLDivElement | null>,
  /** Shown time range in seconds; sets the X-zoom ceiling. */
  tRange: number
): CurveViewport {
  const { w, h } = useElementSize(editorRef)
  const zoomXMax = maxZoomX(w, tRange)
  // For the wheel handler, which is subscribed once.
  const zoomXMaxRef = useRef(zoomXMax)
  useLayoutEffect(() => {
    zoomXMaxRef.current = zoomXMax
  }, [zoomXMax])

  // Pinch (ctrl+wheel), cmd+wheel or the X slider zooms the time axis; 1 = the
  // time range fits the panel. The Y slider zooms the value axis; past 1 the
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
  // zoomX for the wheel handler (subscribed once): lets it detect a clamped
  // pinch, which must not arm the anchor — no render would consume it, and
  // the layout effect (also keyed on `w`) would apply it minutes later on a
  // zoom button press or window resize, jumping the scroll.
  const zoomXRef = useRef(zoomX)
  useLayoutEffect(() => {
    zoomXRef.current = zoomX
  }, [zoomX])
  // scrollLeft to apply after a fit-zoom re-render, same timing as the pinch.
  const fitScroll = useRef<number | null>(null)

  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const scroll = scrollRef.current
      if ((!e.ctrlKey && !e.metaKey) || !scroll) return
      e.preventDefault()
      const next = Math.min(
        Math.max(zoomXRef.current * Math.exp(-e.deltaY * 0.01), 1),
        zoomXMaxRef.current
      )
      if (next === zoomXRef.current) return // clamped: nothing will re-render
      zoomXRef.current = next
      // Anchor from the DOM, not React state: pinch events outrun re-renders,
      // and scrollLeft/scrollWidth are always consistent with each other.
      const viewX = e.clientX - el.getBoundingClientRect().left
      pinchAnchor.current = {
        norm: (scroll.scrollLeft + viewX - PAD) / Math.max(scroll.scrollWidth - 2 * PAD, 1),
        viewX
      }
      setZoomX(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on zoom/size renders only
  }, [zoomX, w])

  const applyFit: CurveViewport['applyFit'] = (fit) => {
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

  // A shrinking time range can drop the ceiling below the current zoom.
  useEffect(() => {
    setZoomX((z) => Math.min(z, zoomXMax))
  }, [zoomXMax])

  return {
    w,
    h,
    zoomX,
    zoomY,
    zoomXMax,
    setZoomX,
    setZoomY,
    innerW,
    innerH,
    scrollTop,
    scrollLeft,
    setScrollLeft,
    handleScroll: (el) => {
      setScrollTop(el.scrollTop)
      setScrollLeft(el.scrollLeft)
    },
    applyFit
  }
}
