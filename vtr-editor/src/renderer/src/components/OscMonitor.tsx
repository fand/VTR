import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { appendRows, type MonitorRow } from './monitorModel'

const ROW_H = 15
const OVERSCAN = 10

/**
 * Live OSC log: everything arriving at vtr-tap's listen port (app traffic;
 * /vtr control is filtered tap-side). Rows are virtualized — only the
 * visible slice hits the DOM, so the 10k-line buffer stays cheap.
 */
export function OscMonitor(): React.JSX.Element {
  const [rows, setRows] = useState<readonly MonitorRow[]>([])
  const [follow, setFollow] = useState(true)
  const nextKey = useRef(0)
  useEffect(
    () => window.api.tap.onMonitor((batch) => setRows((prev) => appendRows(prev, batch, nextKey))),
    []
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])
  // Pin to the bottom after every append while following.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (follow && el) el.scrollTop = el.scrollHeight
  }, [rows, follow])

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  return (
    <div className="osc-monitor">
      <div className="osc-monitor-header">
        <span>OSC</span>
        <div className="spacer" />
        <label className="osc-monitor-follow">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            aria-label="auto-scroll"
          />
          follow
        </label>
        <button
          className="btn small snap"
          data-tip="Clear log"
          aria-label="clear log"
          onClick={() => setRows([])}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div
        className="osc-monitor-scroll"
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div className="osc-monitor-content" style={{ height: rows.length * ROW_H }}>
          {rows.slice(start, end).map((r, i) => (
            <div className="osc-monitor-line" key={r.key} style={{ top: (start + i) * ROW_H }}>
              {r.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
