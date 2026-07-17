import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import type { UndoEntry } from '../shared/types'

const UNDO_FILE = 'undo.jsonl'
/** Entries kept when the log is compacted. */
const CAP = 1000

/** Line counts per log path, so append doesn't re-read the file. */
const counts = new Map<string, number>()

function logPath(dir: string): string {
  return join(dir, UNDO_FILE)
}

export function loadUndoLog(dir: string): UndoEntry[] {
  const path = logPath(dir)
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
  counts.set(path, out.length)
  return out
}

function rewrite(dir: string, entries: UndoEntry[]): void {
  const path = logPath(dir)
  writeFileSync(path + '.tmp', entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  renameSync(path + '.tmp', path)
  counts.set(path, entries.length)
}

export function appendUndo(dir: string, entry: UndoEntry): void {
  const path = logPath(dir)
  const count = (counts.get(path) ?? loadUndoLog(dir).length) + 1
  appendFileSync(path, JSON.stringify(entry) + '\n')
  counts.set(path, count)
  // Compact once the file holds twice what anyone can undo through.
  if (count > 2 * CAP) rewrite(dir, loadUndoLog(dir).slice(-CAP))
}

/** Linear history: a commit after undo drops the redo branch from the log. */
export function truncateUndoAfter(dir: string, seq: number): void {
  rewrite(
    dir,
    loadUndoLog(dir).filter((e) => e.seq <= seq)
  )
}

/** Drop a log (stale staged log from an abandoned untitled session). */
export function clearUndoLog(dir: string): void {
  rmSync(logPath(dir), { force: true })
  counts.delete(logPath(dir))
}

/**
 * The log follows the doc on Save As: a staged (untitled) log moves into the
 * bundle, which owns it now; saving a copy of another project copies its log.
 */
export function transferUndoLog(fromDir: string, toDir: string, move: boolean): void {
  if (fromDir === toDir || !existsSync(logPath(fromDir))) return
  copyFileSync(logPath(fromDir), logPath(toDir))
  counts.delete(logPath(toDir))
  if (move) clearUndoLog(fromDir)
}
