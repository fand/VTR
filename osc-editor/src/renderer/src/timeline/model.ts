import type {
  ClipEdits,
  ClipSummary,
  LoadedProject,
  PortConfig,
  ProjectFile
} from '../../../shared/types'

/** Shortest allowed clip length after trimming, seconds. */
export const MIN_CLIP_LEN = 0.05

export interface ClipInst {
  id: number
  /** File name relative to workdir. */
  file: string
  /** User-given name; the UI falls back to the file name. */
  name?: string
  /** Absolute path. */
  path: string
  /** Timeline seconds where the trimmed clip head sits. */
  offset: number
  trimIn: number
  trimOut: number
  /** Muted clips are skipped on preview/export. */
  muted?: boolean
  summary: ClipSummary
  /** Clip file unreadable at load; rendered grayed out, saved as-is. */
  missing?: boolean
}

export interface TrackState {
  id: number
  /** User-given name; the UI falls back to "Track N". */
  name?: string
  clips: ClipInst[]
}

export interface MarkerState {
  id: number
  /** Timeline seconds. */
  time: number
  /** User label; the UI falls back to the marker number. */
  label?: string
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

export function serializeProject(
  tracks: TrackState[],
  markers: MarkerState[],
  ports: PortConfig,
  duration: number,
  edits: Record<string, ClipEdits>,
  undoSeq: number
): ProjectFile {
  return {
    version: 1,
    ports,
    duration,
    edits,
    undoSeq,
    tracks: tracks.map((track) => ({
      name: track.name,
      clips: track.clips.map(({ file, name, offset, trimIn, trimOut, muted }) => ({
        file,
        name,
        offset,
        trimIn,
        trimOut,
        muted
      }))
    })),
    markers: markers.map(({ time, label }) => ({ time, label }))
  }
}

export function markersFromProject(project: LoadedProject, nextId: () => number): MarkerState[] {
  return (project.markers ?? []).map((m) => ({ id: nextId(), time: m.time, label: m.label }))
}

export function tracksFromProject(project: LoadedProject, nextId: () => number): TrackState[] {
  return project.tracks.map((track) => ({
    id: nextId(),
    name: track.name,
    clips: track.clips.map((c) => ({
      id: nextId(),
      file: c.file,
      name: c.name,
      path: c.path,
      offset: c.offset,
      trimIn: c.trimIn,
      trimOut: c.trimOut,
      muted: c.muted,
      summary: c.summary,
      missing: c.missing
    }))
  }))
}

/** Ruler tick label; shared by the timeline ruler and the curve editor's time axis. */
export function formatRulerLabel(s: number): string {
  if (s >= 60) {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return sec === 0 ? `${m}m` : `${m}m${sec.toFixed(0)}`
  }
  // ≤3 decimals, no trailing zeros (the curve grid steps go below 0.1s).
  return s < 1 ? String(Number(s.toFixed(3))) : `${s.toFixed(0)}s`
}
