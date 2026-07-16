import { renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_PORTS, type ExportResult, type ProjectFile } from '../shared/types'
import { mergeProject } from './merge'

const SESSION_FILE = 'session.jsonl'

/** Write the merged project as a single session JSONL (the app↔TD contract). */
export function exportSession(
  workdir: string,
  project: ProjectFile,
  outPath: string = join(workdir, SESSION_FILE)
): ExportResult {
  const merged = mergeProject(workdir, project)
  const { events } = merged
  // Session length = timeline length (never shorter than the content).
  const duration = Math.max(merged.duration, project.duration ?? 0)
  const ports = project.ports ?? DEFAULT_PORTS
  const lines: string[] = [
    JSON.stringify({
      type: 'session_start',
      t: 0.0,
      wall: new Date().toISOString(),
      host: '127.0.0.1',
      routes: [`${ports.listen}->${ports.forward}`]
    })
  ]
  for (const e of events) {
    lines.push(JSON.stringify({ t: e.t, port: e.port, a: e.a, args: e.args }))
  }
  lines.push(JSON.stringify({ type: 'session_end', t: duration }))

  const tmp = outPath + '.tmp'
  writeFileSync(tmp, lines.join('\n') + '\n')
  renameSync(tmp, outPath)
  return { path: outPath, events: events.length, duration }
}
