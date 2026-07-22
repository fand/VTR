import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import type { UndoEntry } from '../shared/types'
import { appendUndo, loadUndoLog, transferUndoLog, truncateUndoAfter } from './undo'

function entry(seq: number): UndoEntry {
  return { seq, label: `e${seq}`, patches: [], inversePatches: [] }
}

function seqs(dir: string): number[] {
  return loadUndoLog(dir).map((e) => e.seq)
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'vtr-undo-'))
}

test('compaction keeps the entries bridging undoSeq to the tail', () => {
  const dir = tmp()
  for (let i = 1; i <= 2001; i++) appendUndo(dir, entry(i), 1500)
  // Last 1000 saved entries (501..1500) plus the whole unsaved tail; the
  // entries right after undoSeq must survive or boot's redo stack breaks.
  const s = seqs(dir)
  expect(s).toEqual(Array.from({ length: 1501 }, (_, i) => i + 501))
})

test('unsaved tail is never compacted away', () => {
  const dir = tmp()
  for (let i = 1; i <= 2050; i++) appendUndo(dir, entry(i), 0)
  expect(seqs(dir).length).toBe(2050)
})

test('truncateUndoAfter drops the redo branch', () => {
  const dir = tmp()
  for (let i = 1; i <= 5; i++) appendUndo(dir, entry(i), 0)
  truncateUndoAfter(dir, 3)
  expect(seqs(dir)).toEqual([1, 2, 3])
})

test('loadUndoLog drops a torn tail', () => {
  const dir = tmp()
  writeFileSync(
    join(dir, 'undo.jsonl'),
    JSON.stringify(entry(1)) + '\n' + JSON.stringify(entry(2)).slice(0, 10)
  )
  expect(seqs(dir)).toEqual([1])
})

test('transferUndoLog moves a staged log, copies an owned one', () => {
  const staged = tmp()
  const bundleA = tmp()
  const bundleB = tmp()
  appendUndo(staged, entry(1), 0)
  transferUndoLog(staged, bundleA, true)
  expect(existsSync(join(staged, 'undo.jsonl'))).toBe(false)
  expect(seqs(bundleA)).toEqual([1])
  transferUndoLog(bundleA, bundleB, false)
  expect(readFileSync(join(bundleA, 'undo.jsonl'), 'utf8')).toBe(
    readFileSync(join(bundleB, 'undo.jsonl'), 'utf8')
  )
})
