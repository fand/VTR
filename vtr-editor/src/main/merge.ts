import { clampHandleTimes, clipCurve } from '../shared/curve'
import { applyEdits } from '../shared/edits'
import type { ClipCurve, CurveKnot, OscEvent, ProjectFile } from '../shared/types'
import { readClip } from './clips'

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

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

/**
 * Flatten a project to a single event list (plus timeline-space curves) on
 * the editor timeline. Duplicate writes to one address are kept in time
 * order (last-wins on replay).
 */
export function mergeProject(
  resolveClip: (file: string) => string,
  project: ProjectFile
): { events: OscEvent[]; curves: ClipCurve[]; duration: number } {
  const events: OscEvent[] = []
  const curves: ClipCurve[] = []
  let duration = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      // Muted clips still occupy the timeline, so they count into duration.
      duration = Math.max(duration, clip.offset + (clip.trimOut - clip.trimIn))
      if (clip.muted) continue
      let data
      try {
        data = readClip(resolveClip(clip.file))
      } catch {
        continue // missing clip: no events, but it kept its timeline slot above
      }
      const clipEdits = project.edits?.[clip.file]
      // Edits first: a t edit decides whether the event falls inside the trim.
      const clipEvents = applyEdits(data.events, clipEdits)
      for (const e of clipEvents) {
        if (e.t < clip.trimIn || e.t > clip.trimOut) continue
        events.push({
          t: round6(clip.offset + (e.t - clip.trimIn)),
          port: e.port,
          a: e.a,
          args: e.args,
          types: e.types
        })
      }
      clipEdits?.curves?.forEach((c, i) => {
        if (clipEdits.curveDel?.[i]) return
        const placed = placeCurve(c, clip.offset, clip.trimIn, clip.trimOut)
        if (placed) curves.push(placed)
      })
    }
  }
  events.sort((a, b) => a.t - b.t)
  curves.sort((a, b) => a.knots[0].t - b.knots[0].t)
  return { events, curves, duration: round6(duration) }
}
