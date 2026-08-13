import { clampHandleTimes, clipCurve } from '../shared/curve'
import { applyEdits } from '../shared/edits'
import {
  carveKnots,
  clipKeys,
  dropMasked,
  liveCurves,
  maskedAt,
  maskIntervals,
  maskKey,
  resumeEvent,
  round6
} from '../shared/trackMask'
import type { Interval, MaskClip } from '../shared/trackMask'
import type { ClipCurve, ClipEdits, CurveKnot, OscEvent, ProjectFile } from '../shared/types'
import { readClip } from './clips'

/** Overlay curve → timeline space: clip to the trim window (de Casteljau at
 *  the boundaries), then shift onto the timeline. Null when trimmed away. */
function placeCurve(
  curve: ClipCurve,
  offset: number,
  trimIn: number,
  trimOut: number
): ClipCurve | null {
  const clipped = clipCurve(curve.knots, trimIn, trimOut)
  if (!clipped) return null
  // round6 can land a boundary-split sliver knot on its neighbor's grid
  // point; the player rejects non-increasing knots (dropping the whole
  // curve), so collapse equal-t knots instead (the later wins, keeping the
  // curve's end value).
  const knots: CurveKnot[] = []
  for (const k of clipped) {
    const placed = { ...k, t: round6(offset + (k.t - trimIn)) }
    const prev = knots[knots.length - 1]
    if (prev && placed.t <= prev.t) knots[knots.length - 1] = placed
    else knots.push(placed)
  }
  if (knots.length < 2) return null
  // Collapsing can shrink spans below a handle's dt and re-expose boundary
  // handles; restore both invariants.
  delete knots[0].i
  delete knots[knots.length - 1].o
  clampHandleTimes(knots)
  return { ...curve, knots }
}

/** A readable, unmuted clip: read once in pass 1, flattened in pass 2. */
interface Loaded {
  edits?: ClipEdits
  /** Edited, clip-local: a t edit decides trim membership. */
  events: OscEvent[]
  offset: number
  trimIn: number
  trimOut: number
  window: Interval
  keys: Set<string>
}

/**
 * Flatten a project to a single event list (plus timeline-space curves) on
 * the editor timeline. Duplicate writes to one address are kept in time
 * order (last-wins on replay).
 *
 * Two passes, because the lower track wins (docs/tasks/track-priority): pass 1
 * reads every clip and collects the (port, address) windows it carries, pass 2
 * flattens each track with the mask its lower tracks impose — masked events
 * drop, masked curves are carved, and the track resumes its own value after
 * each mask.
 */
export function mergeProject(
  resolveClip: (file: string) => string,
  project: ProjectFile
): { events: OscEvent[]; curves: ClipCurve[]; duration: number } {
  const events: OscEvent[] = []
  const curves: ClipCurve[] = []
  let duration = 0

  // Pass 1: load and place. Muted and missing clips keep their timeline slot
  // but carry no keys, so they mask nothing.
  const loaded: Loaded[][] = []
  for (const track of project.tracks) {
    const list: Loaded[] = []
    for (const clip of track.clips) {
      duration = Math.max(duration, clip.offset + (clip.trimOut - clip.trimIn))
      if (clip.muted) continue
      let data
      try {
        data = readClip(resolveClip(clip.file))
      } catch {
        continue // missing clip: no events, but it kept its timeline slot above
      }
      const edits = project.edits?.[clip.file]
      const clipEvents = applyEdits(data.events, edits)
      list.push({
        edits,
        events: clipEvents,
        offset: clip.offset,
        trimIn: clip.trimIn,
        trimOut: clip.trimOut,
        window: { start: clip.offset, end: clip.offset + (clip.trimOut - clip.trimIn) },
        keys: clipKeys(clipEvents, edits, clip.trimIn, clip.trimOut)
      })
    }
    loaded.push(list)
  }
  const masks = maskIntervals(
    loaded.map((list) => list.map((l): MaskClip => ({ ...l.window, keys: l.keys })))
  )

  // Pass 2: flatten track by track, applying that track's mask.
  loaded.forEach((list, i) => {
    const placedEvents: OscEvent[] = []
    const placedCurves: ClipCurve[] = []
    for (const l of list) {
      for (const e of l.events) {
        if (e.t < l.trimIn || e.t > l.trimOut) continue
        placedEvents.push({
          t: round6(l.offset + (e.t - l.trimIn)),
          port: e.port,
          a: e.a,
          args: e.args,
          types: e.types
        })
      }
      for (const c of liveCurves(l.edits)) {
        const placed = placeCurve(c, l.offset, l.trimIn, l.trimOut)
        if (placed) placedCurves.push(placed)
      }
    }

    const intervals = masks[i]
    for (const e of dropMasked(placedEvents, intervals)) events.push(e)

    // Carved pieces per key: one covering a mask end resumes by itself.
    const pieces = new Map<string, Interval[]>()
    for (const c of placedCurves) {
      const key = maskKey(c.port, c.a)
      const ivs = intervals.get(key)
      if (!ivs) {
        curves.push(c)
        continue
      }
      for (const knots of carveKnots(c.knots, ivs)) {
        curves.push({ ...c, knots })
        const span = { start: knots[0].t, end: knots[knots.length - 1].t }
        const list = pieces.get(key)
        if (list) list.push(span)
        else pieces.set(key, [span])
      }
    }

    // The track's own material per masked key, whole track (its clips never
    // mask each other), so a resume can hold a value defined in an earlier clip.
    const windows = list.map((l) => l.window)
    for (const [key, ivs] of intervals) {
      const material = {
        events: placedEvents.filter((e) => maskKey(e.port, e.a) === key),
        curves: placedCurves.filter((c) => maskKey(c.port, c.a) === key),
        pieces: pieces.get(key) ?? [],
        windows
      }
      if (material.events.length === 0 && material.curves.length === 0) continue
      for (const iv of ivs) {
        const resume = resumeEvent(material, iv.end)
        // A sub-grid gap between two mask windows can land the resume inside
        // the next one; it must not fire under the lower track.
        if (resume && !maskedAt(intervals, key, resume.t)) events.push(resume)
      }
    }
  })

  events.sort((a, b) => a.t - b.t)
  curves.sort((a, b) => a.knots[0].t - b.knots[0].t)
  return { events, curves, duration: round6(duration) }
}
