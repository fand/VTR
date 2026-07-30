import type { ClipCurve, OscEvent } from './types'

// Single owner of the clip/session JSONL line schema (TS side). The Rust
// loaders (vtr-tap writer, vtr-player session.rs) follow the same contract;
// vtr-player/tests/fixtures/session_lines.jsonl pins both sides.

/** Header: recording start. */
export interface SessionStartLine {
  type: 'session_start'
  t: number
  /** Wall-clock start (ISO 8601). */
  wall?: string
  host?: string
  /** "listen->forward" port pairs. */
  routes?: string[]
}

/** Trailer: t is the session duration. */
export interface SessionEndLine {
  type: 'session_end'
  t: number
}

/** Recorder health counters, appended by vtr-tap on stop. */
export interface SummaryLine {
  type: 'summary'
  dropped?: number
  write_errors?: number
  write_error?: string | null
}

/** A bezier curve with timeline-space knots (session exports only). */
export type CurveLine = ClipCurve & { type: 'curve' }

/** An event line carries no `type` field at all. */
export type EventLine = OscEvent

export type JsonlLine = SessionStartLine | SessionEndLine | SummaryLine | CurveLine | EventLine

export type ParsedLine =
  | { kind: 'session_start'; line: SessionStartLine }
  | { kind: 'session_end'; line: SessionEndLine }
  | { kind: 'summary'; line: SummaryLine }
  | { kind: 'curve'; line: CurveLine }
  | { kind: 'event'; line: EventLine }
  /** Unrecognized `type`: skipped, for schema forward compat. */
  | { kind: 'unknown' }
  /** Torn tail from a crash mid-append, or stray corruption. */
  | { kind: 'invalid' }

/**
 * Classify one JSONL line. The dispatch rule shared with the Rust loaders:
 * any object without a `type` field is an event; known types map to their
 * kind; unknown types are tolerated but skipped; everything else (torn
 * JSON, non-objects) is invalid.
 */
export function parseLine(raw: string): ParsedLine {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { kind: 'invalid' }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { kind: 'invalid' }
  const type = (v as { type?: unknown }).type
  if (type == null) return { kind: 'event', line: v as EventLine }
  switch (type) {
    case 'session_start':
      return { kind: 'session_start', line: v as SessionStartLine }
    case 'session_end':
      return { kind: 'session_end', line: v as SessionEndLine }
    case 'summary':
      return { kind: 'summary', line: v as SummaryLine }
    case 'curve':
      return { kind: 'curve', line: v as CurveLine }
    default:
      return { kind: 'unknown' }
  }
}
