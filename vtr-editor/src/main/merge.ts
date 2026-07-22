import { applyEdits } from '../shared/edits'
import type { OscEvent, ProjectFile } from '../shared/types'
import { readClip } from './clips'

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

/**
 * Flatten a project to a single event list on the editor timeline.
 * Duplicate writes to one address are kept in time order (last-wins on replay).
 */
export function mergeProject(
  resolveClip: (file: string) => string,
  project: ProjectFile
): { events: OscEvent[]; duration: number } {
  const events: OscEvent[] = []
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
      // Edits first: a t edit decides whether the event falls inside the trim.
      const clipEvents = applyEdits(data.events, project.edits?.[clip.file])
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
    }
  }
  events.sort((a, b) => a.t - b.t)
  return { events, duration: round6(duration) }
}
