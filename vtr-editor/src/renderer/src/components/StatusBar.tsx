import React from 'react'
import { formatTimecode } from '../timeline/model'

/**
 * Bottom status bar. Left: cursor time on the timeline, selection.
 * Right: the latest event log line (last action, transport, file ops).
 */
export function StatusBar({
  hoverTime,
  selection,
  log
}: {
  hoverTime: number | null
  selection: string | null
  log: string | null
}): React.JSX.Element {
  return (
    <footer className="status-bar">
      <span className="sb-time">{hoverTime != null ? formatTimecode(hoverTime) : ''}</span>
      {selection && <span>{selection}</span>}
      <span className="spacer" />
      {log && <span className="sb-log">{log}</span>}
    </footer>
  )
}
