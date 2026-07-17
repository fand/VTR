import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import type { ProjectFile } from '../shared/types'
import { mergeProject } from './merge'

test('unreadable clip contributes no events but keeps its duration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-mtr-merge-'))
  writeFileSync(join(dir, 'b.jsonl'), '{"t":0.5,"port":10000,"a":"/x","args":[1]}\n')
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          { file: 'gone.jsonl', offset: 0, trimIn: 0, trimOut: 3 },
          { file: 'b.jsonl', offset: 5, trimIn: 0, trimOut: 1 }
        ]
      }
    ]
  }
  const { events, duration } = mergeProject((f) => join(dir, f), project)
  expect(events.map((e) => e.t)).toEqual([5.5])
  expect(duration).toBe(6)
})

test('a t edit decides trim membership: moved out drops, moved in appears', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-mtr-merge-'))
  writeFileSync(
    join(dir, 'c.jsonl'),
    '{"t":1.0,"port":10000,"a":"/in","args":[1]}\n' +
      '{"t":9.0,"port":10000,"a":"/out","args":[2]}\n'
  )
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: 'c.jsonl', offset: 10, trimIn: 0.5, trimOut: 2 }] }],
    edits: {
      'c.jsonl': {
        set: {
          // Originally inside the trim; moved past trimOut → must drop.
          0: { t: 3 },
          // Originally outside; moved inside → must appear, placed by new t.
          1: { t: 1.5 }
        }
      }
    }
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  expect(events.map((e) => e.a)).toEqual(['/out'])
  expect(events[0].t).toBe(11) // offset + (1.5 - trimIn)
})

test('edits on added events merge like recorded ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-mtr-merge-'))
  writeFileSync(join(dir, 'd.jsonl'), '{"t":0.0,"port":10000,"a":"/x","args":[1]}\n')
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: 'd.jsonl', offset: 0, trimIn: 0, trimOut: 5 }] }],
    edits: {
      'd.jsonl': {
        add: [
          { t: 1, port: 10000, a: '/a', args: [1] },
          { t: 2, port: 10000, a: '/b', args: [2] }
        ],
        set: { 1: { t: 4 } }, // first added event (index 1 = original count)
        del: { 2: true } // second added event
      }
    }
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  expect(events.map((e) => [e.a, e.t])).toEqual([
    ['/x', 0],
    ['/a', 4]
  ])
})
