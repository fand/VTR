import { join } from 'path'
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
  workdir: string,
  project: ProjectFile
): { events: OscEvent[]; duration: number } {
  const events: OscEvent[] = []
  let duration = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const data = readClip(join(workdir, clip.file))
      for (const e of data.events) {
        if (e.t < clip.trimIn || e.t > clip.trimOut) continue
        events.push({
          t: round6(clip.offset + (e.t - clip.trimIn)),
          port: e.port,
          a: e.a,
          args: e.args
        })
      }
      duration = Math.max(duration, clip.offset + (clip.trimOut - clip.trimIn))
    }
  }
  events.sort((a, b) => a.t - b.t)
  return { events, duration: round6(duration) }
}
