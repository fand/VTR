/** Status reported by vtr-tap's control API. */
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
  /** Packets received since vtr-tap started (recording or not). */
  received: number
  /** First write failure since the current clip started (latched). */
  write_error: string | null
  write_errors: number
  /** Seconds since the current clip started; null when idle. */
  rec_t: number | null
  /** Most recently finished clip (absolute path). */
  last_clip: string | null
}

/** Recording transition from vtr-tap's event log. */
export type TapEvent =
  { ev: 'rec_started'; clip: string; tl?: number } | { ev: 'rec_stopped'; clip: string }

/** Reply to the control-socket wait cmd. */
export interface TapWaitReply {
  seq: number
  events: TapEvent[]
  /** Cursor unusable (overflow/tap restart) or baseline: re-apply `status`. */
  reset?: boolean
  status?: TapStatus
}

/** What main forwards to the renderer on the tap:event channel. */
export type TapPush = { type: 'event'; event: TapEvent } | { type: 'reset'; status: TapStatus }

/** One OSC event line in a clip/session JSONL file. */
export interface OscEvent {
  t: number
  tl?: number
  port: number
  a: string
  args: unknown[]
  /**
   * OSC type tag string, one char per args element (e.g. "ff").
   * Absent in clips recorded before the field existed; editor-added
   * events copy their template's. Consumers fall back to guessing when
   * it is missing or its length doesn't match args.
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

/** vtr-tap / vtr-player port configuration. */
export interface PortConfig {
  /** UDP port vtr-tap receives OSC on. */
  listen: number
  /** TD port raw datagrams (and preview) are sent to. */
  forward: number
  /** Port controller feedback (rec state + playback mirror) is sent to. */
  echo: number
  /**
   * Host always fed on the echo port, on top of the senders vtr-player picks
   * up by itself. Empty = auto only, which drops a controller that has been
   * quiet for 3 minutes.
   */
  echoHost: string
}

export const DEFAULT_PORTS: PortConfig = {
  listen: 10010,
  forward: 10011,
  echo: 9000,
  echoHost: ''
}

/** IPv4/IPv6 literal, or empty for "auto". Hostnames are not resolved. */
export function isValidEchoHost(host: string): boolean {
  if (host === '') return true
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return host.split('.').every((o) => Number(o) <= 255)
  }
  return /^[0-9a-fA-F:]+$/.test(host) && host.includes(':')
}

/** Loopback port the tap relays /vtr/* control datagrams to (vtr-player). */
export const RELAY_PORT = 10013

/**
 * Back-fill missing ports and drop legacy keys (the removed beacon port)
 * from older project files.
 */
export function normalizePorts(ports?: Partial<PortConfig>): PortConfig {
  const { listen, forward, echo, echoHost } = { ...DEFAULT_PORTS, ...ports }
  return { listen, forward, echo, echoHost: isValidEchoHost(echoHost) ? echoHost : '' }
}

/** Status reported by vtr-player's control API. */
export interface PlayerStatus {
  /** Loaded session file, null when none. */
  loaded: string | null
  playing: boolean
  playhead: number
  connections: number
}

/**
 * Push-transport state: the shared playhead plus who last moved it. `gen`
 * bumps on every accepted mutation; a follower applies an update only when
 * `gen` changed and `origin` is not its own (echo suppression).
 */
export interface TransportState {
  gen: number
  origin: string
  playhead: number
  playing: boolean
}

/** Undo depth: the in-memory stacks and the compacted on-disk log share it. */
export const UNDO_CAP = 1000

/** Default timeline length, seconds. */
export const DEFAULT_DURATION = 60

/**
 * One knot of a piecewise cubic bezier curve. Consecutive knots span one
 * cubic segment: p0/p3 are the knots, p1 = p0 + o, p2 = p3 + i. A missing
 * handle means linear toward that neighbor. Handle dt must keep the
 * segment's time monotone (writers clamp; readers clamp defensively).
 */
export interface CurveKnot {
  t: number
  v: number
  /** Incoming handle offset [dt, dv], dt <= 0. */
  i?: [number, number]
  /** Outgoing handle offset [dt, dv], dt >= 0. */
  o?: [number, number]
  /**
   * Step segment: the value holds at `v` until the next knot's t, then jumps.
   * `o` and the next knot's `i` are dead (writers delete them, readers ignore
   * them). Meaningless on the last knot — flat extension already holds.
   */
  s?: true
}

/**
 * A bezier curve controlling one numeric arg of an address. In a ClipEdits
 * overlay t is clip-local; exported to session.jsonl as a `type:"curve"`
 * line with timeline t. Emissions are `args` with `args[arg]` replaced by
 * the interpolated value; curves on the same (port, a) with different `arg`
 * merge into one message per sample.
 */
export interface ClipCurve {
  port: number
  a: string
  /** Controlled arg index. */
  arg: number
  /** Message template for emissions. */
  args: unknown[]
  /** OSC type tags (same contract as OscEvent.types). */
  types?: string
  /** Knots sorted by strictly increasing t; at least 2. */
  knots: CurveKnot[]
}

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
  /** Bezier curves added by the editor (clip-local t). Append-only. */
  curves?: ClipCurve[]
  /** curveIndex → deleted. Deletes don't shift keys, mirroring `del`. */
  curveDel?: Record<number, true>
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

/** New clip file baked from a merge, ready to place on the timeline. */
export interface MergeClipResult {
  /** Clip file name; the file lives in staging until the project is saved. */
  file: string
  path: string
  summary: ClipSummary
  /** Timeline seconds where the merged clip starts. */
  offset: number
  /** Clip length, seconds (trimOut for the placed clip). */
  length: number
  /** Clip-local curves for the new clip's edit overlay: curves stay curves,
   *  and clip files never carry curve lines. */
  curves: ClipCurve[]
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
