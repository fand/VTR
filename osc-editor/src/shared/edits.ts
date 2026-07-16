import type { ClipEdits, OscEvent } from './types'

export function editsEmpty(edits?: ClipEdits): boolean {
  return (
    !edits ||
    ((!edits.set || Object.keys(edits.set).length === 0) &&
      (!edits.del || Object.keys(edits.del).length === 0))
  )
}

/**
 * Apply an edit overlay to a clip's original events. Returns a new array,
 * re-sorted by t (t edits can reorder events).
 */
export function applyEdits(events: OscEvent[], edits?: ClipEdits): OscEvent[] {
  if (editsEmpty(edits)) return events
  const out: OscEvent[] = []
  for (let i = 0; i < events.length; i++) {
    if (edits!.del?.[i]) continue
    const patch = edits!.set?.[i]
    if (!patch) {
      out.push(events[i])
      continue
    }
    const e = { ...events[i] }
    if (patch.t != null) e.t = patch.t
    if (patch.args) {
      const args = [...e.args]
      for (const [idx, v] of Object.entries(patch.args)) args[Number(idx)] = v
      e.args = args
    }
    out.push(e)
  }
  out.sort((a, b) => a.t - b.t)
  return out
}
