/** UI scale helpers shared by the timeline and the curve panel. */
import React, { useEffect, useState } from 'react'

/** Element size tracked through a ResizeObserver. */
export function useElementSize(ref: React.RefObject<HTMLElement | null>): {
  w: number
  h: number
} {
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

/** Header zoom sliders run 0..100 and map to min..max exponentially. */
export function zoomSlider(
  min: number,
  max: number
): { toSlider: (z: number) => number; fromSlider: (v: number) => number } {
  return {
    toSlider: (z) => (100 * Math.log(z / min)) / Math.log(max / min),
    fromSlider: (v) => min * Math.pow(max / min, v / 100)
  }
}
