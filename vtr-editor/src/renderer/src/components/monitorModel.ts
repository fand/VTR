import type { MonitorLine } from '../../../shared/types'

/** UI-side log cap; the tap-side ring is smaller and drained faster. */
export const MONITOR_MAX_LINES = 10_000

export interface MonitorRow {
  /** Stable render key (monotonic). */
  key: number
  text: string
}

/** `HH:MM:SS.mmm /addr arg arg` — strings JSON-quoted, numbers as recorded. */
export function formatMonitorLine(l: MonitorLine): string {
  const d = new Date(l.wall)
  const p = (n: number, w: number): string => String(n).padStart(w, '0')
  const time = `${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(
    d.getMilliseconds(),
    3
  )}`
  const args = l.args.map((a) => (typeof a === 'string' ? JSON.stringify(a) : String(a))).join(' ')
  return args ? `${time} ${l.a} ${args}` : `${time} ${l.a}`
}

/** Append a batch, dropping the oldest rows beyond MONITOR_MAX_LINES. */
export function appendRows(
  prev: readonly MonitorRow[],
  batch: MonitorLine[],
  nextKey: { current: number }
): MonitorRow[] {
  const rows = batch.map((l) => ({ key: nextKey.current++, text: formatMonitorLine(l) }))
  const all = prev.concat(rows)
  return all.length > MONITOR_MAX_LINES ? all.slice(all.length - MONITOR_MAX_LINES) : all
}
