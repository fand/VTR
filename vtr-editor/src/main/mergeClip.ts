import { round6 } from '../shared/trackMask'
import type { ClipCurve, ProjectFile } from '../shared/types'
import type { EventLine, SessionEndLine, SessionStartLine } from '../shared/jsonl'
import { writeAtomic } from './atomic'
import { mergeProject } from './merge'

/** What the caller needs to place the written clip on the timeline. */
export interface MergedClip {
  /** Timeline seconds where the merged clip starts (its earliest clip head). */
  offset: number
  /** Clip length, seconds: the selection's bounding box. */
  length: number
  /** Clip-local curves for the new clip's edit overlay (never written to the
   *  file — readClip skips curve lines). */
  curves: ClipCurve[]
}

/**
 * Bake a sub-project (the selected clips, in track order) into one new clip
 * file. What lands in the file is what playback resolves for those clips:
 * edits applied, masked events dropped, resumes emitted — the same
 * `mergeProject` the export and the player use.
 *
 * Times come out clip-local (timeline − the earliest head), so the clip drops
 * back onto the timeline at `offset` with trimIn 0. No `tl` fields: they would
 * make Align relocate the clip to a recording position it never had.
 */
export function mergeClipsToFile(
  resolveClip: (file: string) => string,
  project: ProjectFile,
  outPath: string
): MergedClip {
  const clips = project.tracks.flatMap((t) => t.clips)
  if (clips.length === 0) throw new Error('merge needs at least one clip')
  const offset = Math.min(...clips.map((c) => c.offset))
  const { events, curves, duration } = mergeProject(resolveClip, project)
  // duration is the bounding box end (muted clips keep their slot), so the
  // merged clip covers every selected clip, gaps and empty tails included.
  const length = round6(duration - offset)

  const start: SessionStartLine = { type: 'session_start', t: 0.0, wall: new Date().toISOString() }
  const lines: string[] = [JSON.stringify(start)]
  for (const e of events) {
    const line: EventLine = {
      t: round6(e.t - offset),
      port: e.port,
      a: e.a,
      types: e.types,
      args: e.args
    }
    lines.push(JSON.stringify(line))
  }
  const end: SessionEndLine = { type: 'session_end', t: length }
  lines.push(JSON.stringify(end))
  writeAtomic(outPath, lines.join('\n') + '\n')

  // Handles are relative to their knot, so only the knot times shift.
  const local = curves.map((c) => ({
    ...c,
    knots: c.knots.map((k) => ({ ...k, t: round6(k.t - offset) }))
  }))
  return { offset, length, curves: local }
}
