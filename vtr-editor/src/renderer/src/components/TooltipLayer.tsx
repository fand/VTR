import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

const TOOLTIP_DELAY_MS = 500

/**
 * Singleton hover tooltip for [data-tip] elements. Replaces native title=
 * tooltips, whose ~1s delay can't be configured.
 */
export function TooltipLayer(): React.JSX.Element | null {
  const [tip, setTip] = useState<{ text: string; x: number; top: number; bottom: number } | null>(
    null
  )
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let timer = 0
    let current: Element | null = null
    const hide = (): void => {
      window.clearTimeout(timer)
      current = null
      setTip(null)
    }
    const onOver = (e: PointerEvent): void => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null
      if (el === current) return
      window.clearTimeout(timer)
      setTip(null)
      current = el
      if (!el) return
      timer = window.setTimeout(() => {
        // Read at show time: warning tips change while hovered.
        const text = (el as HTMLElement).dataset.tip
        if (!text) return
        const r = el.getBoundingClientRect()
        setTip({ text, x: r.left + r.width / 2, top: r.top, bottom: r.bottom })
      }, TOOLTIP_DELAY_MS)
    }
    const onOut = (e: PointerEvent): void => {
      // Left the window entirely; element-to-element moves go through onOver.
      if (e.relatedTarget == null) hide()
    }
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('scroll', hide, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('scroll', hide, true)
    }
  }, [])
  // Position after render: the box size is unknown until the text is laid out.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !tip) return
    const left = Math.min(
      Math.max(tip.x - el.offsetWidth / 2, 4),
      window.innerWidth - el.offsetWidth - 4
    )
    const below = tip.bottom + 6
    const top =
      below + el.offsetHeight > window.innerHeight - 4 ? tip.top - el.offsetHeight - 6 : below
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [tip])
  if (!tip) return null
  return (
    <div className="app-tooltip" role="tooltip" ref={ref}>
      {tip.text}
    </div>
  )
}
