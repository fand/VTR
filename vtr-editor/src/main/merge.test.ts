import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import type { ProjectFile } from '../shared/types'
import { mergeProject } from './merge'

test('unreadable clip contributes no events but keeps its duration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
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
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
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

test('types survives merge; absent stays absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  writeFileSync(
    join(dir, 'e.jsonl'),
    '{"t":0.5,"port":10000,"a":"/x","types":"fi","args":[0.5,2]}\n' +
      '{"t":1.0,"port":10000,"a":"/y","args":[1]}\n'
  )
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: 'e.jsonl', offset: 0, trimIn: 0, trimOut: 5 }] }]
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  expect(events[0].types).toBe('fi')
  expect('types' in events[1] && events[1].types !== undefined).toBe(false)
})

test('edits on added events merge like recorded ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
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

test('overlay curves land on the timeline, trimmed and shifted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  writeFileSync(join(dir, 'f.jsonl'), '{"t":0.0,"port":10000,"a":"/x","args":[1]}\n')
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: 'f.jsonl', offset: 10, trimIn: 1, trimOut: 3 }] }],
    edits: {
      'f.jsonl': {
        curves: [
          // Spans the whole trim window and beyond: clipped to [1, 3].
          {
            port: 10000,
            a: '/x',
            arg: 0,
            args: [0],
            types: 'f',
            knots: [
              { t: 0, v: 0 },
              { t: 4, v: 1 }
            ]
          },
          // Fully outside the trim window: dropped.
          {
            port: 10000,
            a: '/y',
            arg: 0,
            args: [0],
            types: 'f',
            knots: [
              { t: 3.5, v: 0 },
              { t: 4, v: 1 }
            ]
          }
        ]
      }
    }
  }
  const { curves } = mergeProject((f) => join(dir, f), project)
  expect(curves).toHaveLength(1)
  const knots = curves[0].knots
  // Clip-local [1, 3] → timeline [10, 12].
  expect(knots[0].t).toBe(10)
  expect(knots[knots.length - 1].t).toBe(12)
  // The clipped linear ramp keeps its values: v = t/4 at the boundaries.
  expect(knots[0].v).toBeCloseTo(0.25, 6)
  expect(knots[knots.length - 1].v).toBeCloseTo(0.75, 6)
})

test('curveDel and muted clips drop curves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  writeFileSync(join(dir, 'g.jsonl'), '{"t":0.0,"port":10000,"a":"/x","args":[1]}\n')
  const curve = {
    port: 10000,
    a: '/x',
    arg: 0,
    args: [0],
    types: 'f',
    knots: [
      { t: 0, v: 0 },
      { t: 1, v: 1 }
    ]
  }
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          { file: 'g.jsonl', offset: 0, trimIn: 0, trimOut: 2 },
          { file: 'h.jsonl', offset: 5, trimIn: 0, trimOut: 2, muted: true }
        ]
      }
    ],
    edits: {
      'g.jsonl': { curves: [curve, { ...curve, a: '/kept' }], curveDel: { 0: true } },
      'h.jsonl': { curves: [curve] }
    }
  }
  writeFileSync(join(dir, 'h.jsonl'), '{"t":0.0,"port":10000,"a":"/x","args":[1]}\n')
  const { curves } = mergeProject((f) => join(dir, f), project)
  expect(curves.map((c) => c.a)).toEqual(['/kept'])
})
