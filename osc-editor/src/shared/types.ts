/** Status reported by osc-tap's control API. */
export interface TapStatus {
  recording: boolean
  clip: string | null
  events: number
  beacon_tl: number | null
  beacon_age: number | null
  dropped: number
}

/** One OSC event line in a clip/session JSONL file. */
export interface OscEvent {
  t: number
  tl?: number
  port: number
  a: string
  args: unknown[]
}

/** Parsed clip metadata used by the editor. */
export interface ClipSummary {
  path: string
  name: string
  /** Wall-clock time recording started (ISO 8601), if present. */
  wall: string | null
  /** Seconds from session_start to session_end (or last event). */
  duration: number
  events: number
  /** median(tl - t) over events that carry tl; null if no beacon. */
  tlOffset: number | null
}

/** One clip placed on the timeline (stored in project.json). */
export interface ProjectClip {
  /** Clip file name, relative to the working directory. */
  file: string
  /** Timeline seconds where the trimmed clip head sits. */
  offset: number
  /** Clip-local start, seconds. */
  trimIn: number
  /** Clip-local end, seconds. */
  trimOut: number
}

export interface ProjectFile {
  version: 1
  tracks: { clips: ProjectClip[] }[]
}

/** ProjectClip enriched with parsed clip metadata (load result). */
export interface LoadedClip extends ProjectClip {
  path: string
  summary: ClipSummary
}

export interface ExportResult {
  path: string
  events: number
  duration: number
}

export interface LoadedProject {
  tracks: { clips: LoadedClip[] }[]
  /** Clip files referenced by project.json but unreadable. */
  missing: string[]
}
