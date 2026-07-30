import type { ClipEdits, OscEvent } from './types'

export function editsEmpty(edits?: ClipEdits): boolean {
  return (
    !edits ||
    ((!edits.set || Object.keys(edits.set).length === 0) &&
      (!edits.del || Object.keys(edits.del).length === 0) &&
      (!edits.add || edits.add.length === 0) &&
      (!edits.curves || edits.curves.length === 0))
  )
}

/** An edited event paired with its index in the original clip file. */
export interface IndexedEvent {
  ev: OscEvent
  idx: number
}

/**
 * Apply an edit overlay to a clip's original events, keeping each event's
 * original index (the key space of ClipEdits). Re-sorted by t.
 */
export function applyEditsIndexed(events: OscEvent[], edits?: ClipEdits): IndexedEvent[] {
  const out: IndexedEvent[] = []
  // Added events take the keys past the original count (add is append-only),
  // so set/del apply to them the same way.
  const all = edits?.add && edits.add.length > 0 ? [...events, ...edits.add] : events
  for (let i = 0; i < all.length; i++) {
    if (edits?.del?.[i]) continue
    const patch = edits?.set?.[i]
    if (!patch) {
      out.push({ ev: all[i], idx: i })
      continue
    }
    const e = { ...all[i] }
    if (patch.t != null) e.t = patch.t
    if (patch.args) {
      const args = [...e.args]
      for (const [idx, v] of Object.entries(patch.args)) args[Number(idx)] = v
      e.args = args
    }
    out.push({ ev: e, idx: i })
  }
  out.sort((a, b) => a.ev.t - b.ev.t)
  return out
}

/** Same, without the index bookkeeping (export/preview path). */
export function applyEdits(events: OscEvent[], edits?: ClipEdits): OscEvent[] {
  if (editsEmpty(edits)) return events
  return applyEditsIndexed(events, edits).map((x) => x.ev)
}
