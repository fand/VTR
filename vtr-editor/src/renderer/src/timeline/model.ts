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

/**
 * Human-readable "this recording lost data" line, or null for a clean clip.
 * Shared by the live recording row (from TapStatus) and recorded clips
 * (from the clip's summary line).
 */
export function recordingWarning(
  dropped: number,
  writeErrors: number,
  writeError: string | null
): string | null {
  if (dropped === 0 && writeErrors === 0) return null
  const parts: string[] = []
  if (dropped > 0) parts.push(`${dropped} dropped`)
  if (writeErrors > 0) {
    parts.push(`${writeErrors} write failure${writeErrors === 1 ? '' : 's'}`)
  }
  let text = `recording lost data: ${parts.join(', ')}`
  if (writeError) text += ` — ${writeError}`
  return text
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

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

/** HH:MM:SS.mmm; shared by the transport display and the rulers. */
export function formatTimecode(s: number): string {
  const ms = Math.round(s * 1000)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms / 60000) % 60
  const sec = Math.floor(ms / 1000) % 60
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)}.${pad(ms % 1000, 3)}`
}

/**
 * Ruler tick label; shared by the timeline ruler and the curve editor's time
 * axis. Whole-second steps drop the ms part.
 */
export function formatRulerLabel(s: number, step: number): string {
  const tc = formatTimecode(s)
  return step >= 1 ? tc.slice(0, 8) : tc
}

/**
 * Smallest step from `steps` (ascending) that keeps ticks at least minPx
 * apart across `range` drawn over `pixels`; the coarsest step if none does.
 * Backs both rulers and the curve panel's grid.
 */
export function pickStep(
  steps: readonly number[],
  range: number,
  pixels: number,
  minPx: number
): number {
  for (const s of steps) {
    if ((s / range) * pixels >= minPx) return s
  }
  return steps[steps.length - 1]
}

/** Min px between time ticks; fits a `formatRulerLabel` HH:MM:SS.mmm label. */
export const TIME_TICK_MIN_PX = 90

/** How close a snap target has to be to catch a drag, in screen px. Shared by
 *  the timeline and the curve editor, so both feel the same. */
export const SNAP_PX = 8

/**
 * Smallest correction that lands t on a candidate within radius, or 0 when
 * none is close enough. Candidates are compared in order, so a later one only
 * wins a tie. Backs both snapping drags: clip edges, datapoints, whole seconds.
 */
export function bestSnap(t: number, radius: number, candidates: Iterable<number>): number {
  let best = 0
  let bestAbs = radius
  for (const c of candidates) {
    const diff = c - t
    if (Math.abs(diff) <= bestAbs) {
      bestAbs = Math.abs(diff)
      best = diff
    }
  }
  return best
}

export const MIN_PX_PER_SEC = 2
/** Zoom ceiling: one 60fps frame spans 24px, so max zoom resolves single frames. */
export const MAX_PX_PER_SEC = 24 * 60

const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]

/** Timeline ruler tick interval, in seconds. */
export function rulerStep(pxPerSec: number): number {
  return pickStep(RULER_STEPS, 1, pxPerSec, TIME_TICK_MIN_PX)
}

/** Curve-panel grid intervals; finer than the ruler's, since it zooms deeper
 *  and the same ladder also scales the value axis. */
const GRID_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120]

/** Curve-panel grid interval, for either axis (`minPx` sets which). */
export function gridStep(range: number, pixels: number, minPx: number): number {
  return pickStep(GRID_STEPS, range, pixels, minPx)
}

/** Decimal places needed to print multiples of step exactly. */
export function stepDecimals(step: number): number {
  return Math.max(0, -Math.floor(Math.log10(step)))
}
