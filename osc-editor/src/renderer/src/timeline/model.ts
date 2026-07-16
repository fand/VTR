import type { ClipSummary, LoadedProject, ProjectFile } from '../../../shared/types'

/** Shortest allowed clip length after trimming, seconds. */
export const MIN_CLIP_LEN = 0.05

export interface ClipInst {
  id: number
  /** File name relative to workdir. */
  file: string
  /** Absolute path. */
  path: string
  /** Timeline seconds where the trimmed clip head sits. */
  offset: number
  trimIn: number
  trimOut: number
  summary: ClipSummary
}

export interface TrackState {
  id: number
  clips: ClipInst[]
}

export function clipLen(c: ClipInst): number {
  return c.trimOut - c.trimIn
}

/** Timeline second where the last clip ends. */
export function contentEnd(tracks: TrackState[]): number {
  let end = 0
  for (const track of tracks) {
    for (const c of track.clips) {
      end = Math.max(end, c.offset + clipLen(c))
    }
  }
  return end
}

/** Place the clip so events land at their TD timeline time (tl). No-op without tl. */
export function alignClip(c: ClipInst): ClipInst {
  if (c.summary.tlOffset == null) return c
  return { ...c, offset: Math.max(0, c.trimIn + c.summary.tlOffset) }
}

export function serializeProject(tracks: TrackState[]): ProjectFile {
  return {
    version: 1,
    tracks: tracks.map((track) => ({
      clips: track.clips.map(({ file, offset, trimIn, trimOut }) => ({
        file,
        offset,
        trimIn,
        trimOut
      }))
    }))
  }
}

export function tracksFromProject(
  project: LoadedProject,
  nextId: () => number
): TrackState[] {
  return project.tracks
    .filter((t) => t.clips.length > 0)
    .map((track) => ({
      id: nextId(),
      clips: track.clips.map((c) => ({
        id: nextId(),
        file: c.file,
        path: c.path,
        offset: c.offset,
        trimIn: c.trimIn,
        trimOut: c.trimOut,
        summary: c.summary
      }))
    }))
}
