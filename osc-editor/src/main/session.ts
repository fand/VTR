import { renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ExportResult, ProjectFile } from '../shared/types'
import { mergeProject } from './merge'

const SESSION_FILE = 'session.jsonl'

/** Write the merged project as a single session.jsonl (the app↔TD contract). */
export function exportSession(workdir: string, project: ProjectFile): ExportResult {
  const { events, duration } = mergeProject(workdir, project)
  const lines: string[] = [
    JSON.stringify({
      type: 'session_start',
      t: 0.0,
      wall: new Date().toISOString(),
      host: '127.0.0.1',
      routes: ['10010->10011']
    })
  ]
  for (const e of events) {
    lines.push(JSON.stringify({ t: e.t, port: e.port, a: e.a, args: e.args }))
  }
  lines.push(JSON.stringify({ type: 'session_end', t: duration }))

  const path = join(workdir, SESSION_FILE)
  const tmp = path + '.tmp'
  writeFileSync(tmp, lines.join('\n') + '\n')
  renameSync(tmp, path)
  return { path, events: events.length, duration }
}
