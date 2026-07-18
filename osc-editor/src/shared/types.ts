/** Status reported by osc-tap's control API. */
export interface TapStatus {
  recording: boolean
  clip: string | null
  events: number
  beacon_tl: number | null
  beacon_age: number | null
  /** Timeline speed from the last /clock beacon (1 = playing, 0 = paused). */
  beacon_rate: number | null
  /** Packets dropped since the current clip started. */
  dropped: number
  /** Packets received since osc-tap started (recording or not). */
  received: number
  /** First write failure since the current clip started (latched). */
  write_error: string | null
  write_errors: number
}

/** One OSC event line in a clip/session JSONL file. */
export interface OscEvent {
  t: number
  tl?: number
  port: number
  a: string
  args: unknown[]
  /**
   * OSC type tag string, one char per args element (e.g. "ff").
   * Absent in clips recorded before the field existed and in
   * editor-added events; consumers then fall back to guessing.
   * An `h` tag may carry its arg as a decimal string (int64 > 2^53).
   */
  types?: string
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
  /**
   * Recording health from the clip's summary line. Zero/null for clips
   * recorded before the summary record existed.
   */
  dropped: number
  writeErrors: number
  writeError: string | null
}

/** osc-tap port configuration. */
export interface PortConfig {
  /** UDP port osc-tap receives OSC on. */
  listen: number
  /** TD port raw datagrams (and preview) are sent to. */
  forward: number
  /** UDP port /clock beacons are received on. */
  beacon: number
}

export const DEFAULT_PORTS: PortConfig = { listen: 10010, forward: 10011, beacon: 10012 }

/** Undo depth: the in-memory stacks and the compacted on-disk log share it. */
export const UNDO_CAP = 1000

/** Default timeline length, seconds. */
export const DEFAULT_DURATION = 60

/**
 * Non-destructive edit overlay on a clip file's events. Keys are the event's
 * index in the original JSONL (deletes don't shift keys). The recording itself
 * is never rewritten.
 */
export interface ClipEdits {
  /** eventIndex → partial patch; args maps argIndex → new numeric value. */
  set?: Record<number, { t?: number; args?: Record<number, number> }>
  /** eventIndex → deleted. Wins over set. */
  del?: Record<number, true>
  /**
   * Events added by the editor (clip-local t). Append-only: their edit keys
   * start at the original event count and never shift.
   */
  add?: OscEvent[]
}

/** Structural mirror of immer's Patch (kept immer-free for the main process). */
export interface UndoPatch {
  op: 'replace' | 'remove' | 'add'
  path: (string | number)[]
  value?: unknown
}

/** One undoable change, persisted as a line of undo.jsonl. */
export interface UndoEntry {
  seq: number
  label: string
  patches: UndoPatch[]
  inversePatches: UndoPatch[]
}

/** One timeline marker (stored in project.json). */
export interface ProjectMarker {
  /** Timeline seconds. */
  time: number
  /** User label; the UI falls back to a number. */
  label?: string
}

/** One clip placed on the timeline (stored in project.json). */
export interface ProjectClip {
  /** Clip file name, relative to the working directory. */
  file: string
  /** User-given name; the UI falls back to the file name. */
  name?: string
  /** Timeline seconds where the trimmed clip head sits. */
  offset: number
  /** Clip-local start, seconds. */
  trimIn: number
  /** Clip-local end, seconds. */
  trimOut: number
  /** Muted clips are skipped on preview/export. */
  muted?: boolean
}

export interface ProjectFile {
  version: 1
  ports?: PortConfig
  /** Timeline length, seconds. Export session_end is at least this. */
  duration?: number
  tracks: { name?: string; clips: ProjectClip[] }[]
  markers?: ProjectMarker[]
  /**
   * Edit overlays keyed by clip file name. Carried inline over IPC (autosave is
   * debounced, so main must never read sidecars for preview/export), but
   * persisted as <file>.edits.json sidecars to keep project.json small.
   */
  edits?: Record<string, ClipEdits>
  /**
   * Undo seq of the saved doc: the boot-time cursor into undo.jsonl. Entries
   * at or below it become the undo stack, the rest the redo stack.
   */
  undoSeq?: number
}

/** ProjectClip enriched with parsed clip metadata (load result). */
export interface LoadedClip extends ProjectClip {
  path: string
  /** Stub (0 events) when missing; kept non-null so the UI needs no null checks. */
  summary: ClipSummary
  /** Clip file unreadable at load; the reference is kept so save round-trips it. */
  missing?: boolean
}

export interface ExportResult {
  path: string
  events: number
  duration: number
}

export interface LoadedProject {
  ports?: PortConfig
  duration?: number
  tracks: { name?: string; clips: LoadedClip[] }[]
  markers?: ProjectMarker[]
  /** Edit overlays read back from sidecar files. */
  edits: Record<string, ClipEdits>
  undoSeq?: number
  /** Clip files referenced by project.json but unreadable. */
  missing: string[]
}
