import type { CurveLine, EventLine, SessionEndLine, SessionStartLine } from '../shared/jsonl'
import { DEFAULT_PORTS, type ExportResult, type ProjectFile } from '../shared/types'
import { writeAtomic } from './atomic'
import { mergeProject } from './merge'

export const SESSION_FILE = 'session.jsonl'

/** Write the merged project as a single session JSONL (the app↔TD contract). */
export function exportSession(
  resolveClip: (file: string) => string,
  project: ProjectFile,
  outPath: string
): ExportResult {
  const merged = mergeProject(resolveClip, project)
  const { events, curves } = merged
  // Session length = timeline length (never shorter than the content).
  const duration = Math.max(merged.duration, project.duration ?? 0)
  const ports = project.ports ?? DEFAULT_PORTS
  const start: SessionStartLine = {
    type: 'session_start',
    t: 0.0,
    wall: new Date().toISOString(),
    host: '127.0.0.1',
    routes: [`${ports.listen}->${ports.forward}`]
  }
  const lines: string[] = [JSON.stringify(start)]
  for (const e of events) {
    // Deliberately no tl: exported times are timeline times already.
    const line: EventLine = { t: e.t, port: e.port, a: e.a, types: e.types, args: e.args }
    lines.push(JSON.stringify(line))
  }
  // Curve lines after the events: loaders don't care about the order, but
  // stable output diffs nicely. Old players skip them (unknown type).
  for (const c of curves) {
    const line: CurveLine = {
      type: 'curve',
      port: c.port,
      a: c.a,
      arg: c.arg,
      types: c.types,
      args: c.args,
      knots: c.knots
    }
    lines.push(JSON.stringify(line))
  }
  const endLine: SessionEndLine = { type: 'session_end', t: duration }
  lines.push(JSON.stringify(endLine))

  // TD replays this file at the show: fsync + unique tmp (writeAtomic) so a
  // crash mid-export can't publish a truncated session over a good one.
  writeAtomic(outPath, lines.join('\n') + '\n')
  return { path: outPath, events: events.length, duration }
}
