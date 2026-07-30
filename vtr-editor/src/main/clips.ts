import { readFileSync } from 'fs'
import { basename } from 'path'
import { parseLine } from '../shared/jsonl'
import type { ClipSummary, OscEvent } from '../shared/types'

export interface ClipData {
  path: string
  wall: string | null
  events: OscEvent[]
  /** session_end t, or last event t if the clip was cut short. */
  duration: number
  /** median(tl - t); null if no event carries tl. */
  tlOffset: number | null
  /** Health counters from the summary line; zeros for clips without one. */
  dropped: number
  writeErrors: number
  writeError: string | null
}

export function readClip(path: string): ClipData {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  let wall: string | null = null
  let end: number | null = null
  let dropped = 0
  let writeErrors = 0
  let writeError: string | null = null
  const events: OscEvent[] = []
  for (const raw of lines) {
    const p = parseLine(raw)
    switch (p.kind) {
      case 'session_start':
        wall = p.line.wall ?? null
        break
      case 'session_end':
        end = p.line.t
        break
      case 'summary':
        dropped = p.line.dropped ?? 0
        writeErrors = p.line.write_errors ?? 0
        writeError = p.line.write_error ?? null
        break
      case 'event':
        events.push(p.line)
        break
      // curve (never recorded into clips), unknown, invalid: skipped.
    }
  }
  const lastT = events.length > 0 ? events[events.length - 1].t : 0
  const duration = Math.max(end ?? 0, lastT)
  const offsets = events
    .filter((e) => typeof e.tl === 'number')
    .map((e) => (e.tl as number) - e.t)
    .sort((a, b) => a - b)
  const tlOffset = offsets.length > 0 ? offsets[Math.floor(offsets.length / 2)] : null
  return { path, wall, events, duration, tlOffset, dropped, writeErrors, writeError }
}

export function clipSummary(path: string): ClipSummary {
  const data = readClip(path)
  return {
    path,
    name: basename(path),
    wall: data.wall,
    duration: data.duration,
    events: data.events.length,
    tlOffset: data.tlOffset,
    dropped: data.dropped,
    writeErrors: data.writeErrors,
    writeError: data.writeError
  }
}
