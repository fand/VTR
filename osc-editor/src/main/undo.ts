import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { UndoEntry } from '../shared/types'

const UNDO_FILE = 'undo.jsonl'
/** Entries kept when the log is compacted. */
const CAP = 1000

let count: number | null = null

function logPath(workdir: string): string {
  return join(workdir, UNDO_FILE)
}

export function loadUndoLog(workdir: string): UndoEntry[] {
  const path = logPath(workdir)
  const out: UndoEntry[] = []
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as UndoEntry)
      } catch {
        break // torn tail from a crash mid-append; drop it and everything after
      }
    }
  }
  count = out.length
  return out
}

function rewrite(workdir: string, entries: UndoEntry[]): void {
  const path = logPath(workdir)
  writeFileSync(path + '.tmp', entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  renameSync(path + '.tmp', path)
  count = entries.length
}

export function appendUndo(workdir: string, entry: UndoEntry): void {
  count ??= loadUndoLog(workdir).length
  appendFileSync(logPath(workdir), JSON.stringify(entry) + '\n')
  count++
  // Compact once the file holds twice what anyone can undo through.
  if (count > 2 * CAP) rewrite(workdir, loadUndoLog(workdir).slice(-CAP))
}

/** Linear history: a commit after undo drops the redo branch from the log. */
export function truncateUndoAfter(workdir: string, seq: number): void {
  rewrite(
    workdir,
    loadUndoLog(workdir).filter((e) => e.seq <= seq)
  )
}
