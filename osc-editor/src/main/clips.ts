import { readFileSync } from 'fs'
import { basename } from 'path'
import type { ClipSummary, OscEvent } from '../shared/types'

export interface ClipData {
  path: string
  wall: string | null
  events: OscEvent[]
  /** session_end t, or last event t if the clip was cut short. */
  duration: number
  /** median(tl - t); null if no event carries tl. */
  tlOffset: number | null
}

export function readClip(path: string): ClipData {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  let wall: string | null = null
  let end: number | null = null
  const events: OscEvent[] = []
  for (const line of lines) {
    let v
    try {
      v = JSON.parse(line)
    } catch {
      continue // torn tail from a crash mid-append, or stray corruption
    }
    if (v.type === 'session_start') wall = v.wall ?? null
    else if (v.type === 'session_end') end = v.t
    else events.push(v as OscEvent)
  }
  const lastT = events.length > 0 ? events[events.length - 1].t : 0
  const duration = Math.max(end ?? 0, lastT)
  const offsets = events
    .filter((e) => typeof e.tl === 'number')
    .map((e) => (e.tl as number) - e.t)
    .sort((a, b) => a - b)
  const tlOffset = offsets.length > 0 ? offsets[Math.floor(offsets.length / 2)] : null
  return { path, wall, events, duration, tlOffset }
}

export function clipSummary(path: string): ClipSummary {
  const data = readClip(path)
  return {
    path,
    name: basename(path),
    wall: data.wall,
    duration: data.duration,
    events: data.events.length,
    tlOffset: data.tlOffset
  }
}
