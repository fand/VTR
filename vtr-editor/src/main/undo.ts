import { appendFileSync, copyFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { UNDO_CAP, type UndoEntry } from '../shared/types'
import { writeAtomic } from './atomic'

const UNDO_FILE = 'undo.jsonl'

/** Line counts per log path, so append doesn't re-read the file. */
const counts = new Map<string, number>()

/** savedSeq of the last compaction attempt that dropped nothing. Only the
 *  saved prefix (seq <= savedSeq) may compact, and it only grows when a
 *  save moves savedSeq — retrying before then would re-read and re-parse
 *  the whole log on every edit of a long unsaved session for nothing. */
const compactStale = new Map<string, number>()

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
  writeAtomic(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  counts.set(path, entries.length)
}

export function appendUndo(dir: string, entry: UndoEntry, savedSeq: number): void {
  const path = logPath(dir)
  const count = (counts.get(path) ?? loadUndoLog(dir).length) + 1
  appendFileSync(path, JSON.stringify(entry) + '\n')
  counts.set(path, count)
  // Compact once the file holds twice what anyone can undo through. Only
  // saved-doc history (seq <= savedSeq) may go: everything past savedSeq is
  // boot's redo/crash-recovery tail and must stay contiguous from savedSeq.
  if (count > 2 * UNDO_CAP && compactStale.get(path) !== savedSeq) {
    const entries = loadUndoLog(dir)
    const saved = entries.filter((e) => e.seq <= savedSeq)
    const tail = entries.filter((e) => e.seq > savedSeq)
    const kept = [...saved.slice(-UNDO_CAP), ...tail]
    if (kept.length < entries.length) rewrite(dir, kept)
    else compactStale.set(path, savedSeq)
  }
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
  compactStale.delete(logPath(dir))
}

/**
 * The log follows the doc on Save As: a staged (untitled) log moves into the
 * bundle, which owns it now; saving a copy of another project copies its log.
 */
export function transferUndoLog(fromDir: string, toDir: string, move: boolean): void {
  if (fromDir === toDir || !existsSync(logPath(fromDir))) return
  copyFileSync(logPath(fromDir), logPath(toDir))
  counts.delete(logPath(toDir))
  compactStale.delete(logPath(toDir))
  if (move) clearUndoLog(fromDir)
}
