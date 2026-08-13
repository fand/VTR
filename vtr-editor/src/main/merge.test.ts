import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import type { ClipCurve, CurveKnot, ProjectFile } from '../shared/types'
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

test('a trim boundary within round6 of a knot keeps the curve valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  writeFileSync(join(dir, 'f.jsonl'), '{"t":0.0,"port":10000,"a":"/x","args":[1]}\n')
  const project: ProjectFile = {
    version: 1,
    // trimIn lands 4e-7 left of the middle knot: the boundary split emits a
    // sliver segment that round6 collapses.
    tracks: [{ clips: [{ file: 'f.jsonl', offset: 0, trimIn: 0.9999996, trimOut: 3 }] }],
    edits: {
      'f.jsonl': {
        curves: [
          {
            port: 10000,
            a: '/x',
            arg: 0,
            args: [0],
            types: 'f',
            knots: [
              { t: 0, v: 0 },
              { t: 1, v: 0.5, o: [0.3, 0.1] },
              { t: 2, v: 1 }
            ]
          }
        ]
      }
    }
  }
  const { curves } = mergeProject((f) => join(dir, f), project)
  expect(curves).toHaveLength(1)
  const knots = curves[0].knots
  // The sliver knot collapsed into the middle knot, which now opens the curve.
  expect(knots).toHaveLength(2)
  expect(knots[0].v).toBeCloseTo(0.5, 6)
  // Strictly increasing t (the player rejects the whole curve otherwise).
  for (let i = 1; i < knots.length; i++) {
    expect(knots[i].t).toBeGreaterThan(knots[i - 1].t)
  }
  // Boundary knots keep only inward handles; handle dts stay in their spans.
  expect(knots[0].i).toBeUndefined()
  expect(knots[knots.length - 1].o).toBeUndefined()
  for (let i = 0; i < knots.length; i++) {
    const o = knots[i].o
    if (o) expect(o[0]).toBeLessThanOrEqual(knots[i + 1].t - knots[i].t)
    const inn = knots[i].i
    if (inn) expect(-inn[0]).toBeLessThanOrEqual(knots[i].t - knots[i - 1].t)
  }
})

test('a trimmed clip exports step segments with s intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  writeFileSync(join(dir, 'i.jsonl'), '{"t":0.0,"port":10000,"a":"/x","args":[1]}\n')
  const project: ProjectFile = {
    version: 1,
    // trimIn splits the bezier segment *before* a step knot; trimOut splits a
    // step segment itself.
    tracks: [{ clips: [{ file: 'i.jsonl', offset: 10, trimIn: 0.5, trimOut: 2.5 }] }],
    edits: {
      'i.jsonl': {
        curves: [
          {
            port: 10000,
            a: '/x',
            arg: 0,
            args: [0],
            types: 'f',
            knots: [
              { t: 0, v: 0 },
              { t: 1, v: 1, s: true },
              { t: 2, v: 0.25, s: true },
              { t: 3, v: 0.75 }
            ]
          }
        ]
      }
    }
  }
  const { curves } = mergeProject((f) => join(dir, f), project)
  const knots = curves[0].knots
  expect(knots.map((k) => k.t)).toEqual([10, 10.5, 11.5, 12])
  expect(knots.map((k) => k.s ?? false)).toEqual([false, true, true, false])
  // Held values, not a ramp: the trimOut split stays on the step's left value.
  expect(knots[0].v).toBeCloseTo(0.5, 6)
  expect(knots[1].v).toBe(1)
  expect(knots[2].v).toBe(0.25)
  expect(knots[3].v).toBe(0.25)
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

// --- track priority: the lower track wins (docs/tasks/track-priority) ---

const PORT = 10000

/** One clip file of plain events; returns its name for the project. */
function clipOf(
  dir: string,
  name: string,
  events: { t: number; a?: string; v?: number; port?: number }[]
): string {
  const lines = events.map((e) =>
    JSON.stringify({ t: e.t, port: e.port ?? PORT, a: e.a ?? '/a', args: [e.v ?? 0] })
  )
  writeFileSync(join(dir, name), lines.map((l) => l + '\n').join(''))
  return name
}

function curveOf(knots: CurveKnot[], a = '/a', port = PORT): ClipCurve {
  return { port, a, arg: 0, args: [0], types: 'f', knots }
}

/** A two-knot ramp. */
const seg = (t0: number, v0: number, t1: number, v1: number): CurveKnot[] => [
  { t: t0, v: v0 },
  { t: t1, v: v1 }
]

/** Compact view of a merged event list. */
const shape = (events: { t: number; a: string; args: unknown[] }[]): unknown[][] =>
  events.map((e) => [e.a, e.t, e.args[0]])

test('the take beats the curve above it: curve carved in two, take intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      { clips: [{ file: clipOf(dir, 'up.jsonl', []), offset: 0, trimIn: 0, trimOut: 10 }] },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [
              { t: 0, v: 0.9 },
              { t: 2, v: 0.95 }
            ]),
            offset: 2,
            trimIn: 0,
            trimOut: 2
          }
        ]
      }
    ],
    edits: {
      'up.jsonl': {
        curves: [
          curveOf([
            { t: 0, v: 0 },
            { t: 10, v: 1 }
          ])
        ]
      }
    }
  }
  const { events, curves } = mergeProject((f) => join(dir, f), project)
  // The take loses nothing, and the carved right piece resumes by itself, so
  // no synthetic event joins it.
  expect(shape(events)).toEqual([
    ['/a', 2, 0.9],
    ['/a', 4, 0.95]
  ])
  expect(curves.map((c) => [c.knots[0].t, c.knots[c.knots.length - 1].t])).toEqual([
    [0, 1.999999],
    [4.000001, 10]
  ])
})

test('discrete over discrete: masked events drop and the track resumes after the take', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'up.jsonl', [
              { t: 1, v: 0.1 },
              { t: 2, v: 0.2 },
              { t: 3, v: 0.3 }
            ]),
            offset: 0,
            trimIn: 0,
            trimOut: 10
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [
              { t: 0, v: 0.9 },
              { t: 2, v: 0.95 }
            ]),
            offset: 2,
            trimIn: 0,
            trimOut: 2
          }
        ]
      }
    ]
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  // The resume carries the upper track's latest masked value and sorts after
  // the take's boundary event at 4, so the take still wins at the boundary.
  expect(shape(events)).toEqual([
    ['/a', 1, 0.1],
    ['/a', 2, 0.9],
    ['/a', 4, 0.95],
    ['/a', 4.000001, 0.3]
  ])
})

test('a curve fully inside the take is dropped and resumes with its end value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      { clips: [{ file: clipOf(dir, 'up.jsonl', []), offset: 0, trimIn: 0, trimOut: 10 }] },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [{ t: 0, v: 0.9 }]),
            offset: 2,
            trimIn: 0,
            trimOut: 2
          }
        ]
      }
    ],
    edits: { 'up.jsonl': { curves: [curveOf(seg(2, 0.2, 3, 0.8))] } }
  }
  const { events, curves } = mergeProject((f) => join(dir, f), project)
  expect(curves).toEqual([])
  expect(shape(events)).toEqual([
    ['/a', 2, 0.9],
    ['/a', 4.000001, 0.8]
  ])
})

test('a swallowed curve arg patches every surviving piece template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      { clips: [{ file: clipOf(dir, 'up.jsonl', []), offset: 0, trimIn: 0, trimOut: 10 }] },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [{ t: 0, a: '/xy', v: 0.9 }]),
            offset: 2,
            trimIn: 0,
            trimOut: 2
          }
        ]
      }
    ],
    edits: {
      'up.jsonl': {
        curves: [
          // Arg 0 survives the [2, 4] mask in two pieces; arg 1 is swallowed
          // whole, so only the arg-0 pieces can re-assert it.
          { port: PORT, a: '/xy', arg: 0, args: [0, 0], types: 'ff', knots: seg(0, 0, 10, 1) },
          {
            port: PORT,
            a: '/xy',
            arg: 1,
            args: [0, 0],
            types: 'ff',
            knots: seg(2.5, 0.2, 3.5, 0.8)
          }
        ]
      }
    }
  }
  const { events, curves } = mergeProject((f) => join(dir, f), project)
  expect(curves.map((c) => [c.knots[0].t, c.args, c.types])).toEqual([
    [0, [0, 0], 'ff'], // pre-mask piece: untouched
    [4.000001, [0, 0.8], 'ff'] // post-mask piece: carries the swallowed arg
  ])
  // The pieces resume, so no synthetic event.
  expect(shape(events)).toEqual([['/xy', 2, 0.9]])
})

test('the template patch skips args the masked track never defines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'up.jsonl', [{ t: 1, a: '/m', v: 0.1 }]),
            offset: 0,
            trimIn: 0,
            trimOut: 10
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [{ t: 0, a: '/m', v: 0.9 }]),
            offset: 2,
            trimIn: 0,
            trimOut: 2
          }
        ]
      }
    ],
    edits: {
      'up.jsonl': {
        curves: [
          // Arg 0 survives (it starts before the mask); arg 2 is swallowed.
          // Arg 1 is defined by nobody: the 1-arg event and the swallowed
          // curve's own template only fill it, so it must not be spliced.
          {
            port: PORT,
            a: '/m',
            arg: 0,
            args: [0, 99, 99],
            types: 'fff',
            knots: seg(1.5, 0, 10, 1)
          },
          {
            port: PORT,
            a: '/m',
            arg: 2,
            args: [0, 55, 0.2],
            types: 'fff',
            knots: seg(2.5, 0.2, 3.5, 0.8)
          }
        ]
      }
    }
  }
  const { events, curves } = mergeProject((f) => join(dir, f), project)
  expect(curves.map((c) => c.args)).toEqual([
    [0, 99, 99],
    [0, 99, 0.8] // arg 1 keeps the piece's own 99, not the resolved 55
  ])
  expect(shape(events)).toEqual([
    ['/m', 1, 0.1],
    ['/m', 2, 0.9]
  ])
})

test('every curve arg swallowed: one resume event carries them all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      { clips: [{ file: clipOf(dir, 'up.jsonl', []), offset: 0, trimIn: 0, trimOut: 10 }] },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [{ t: 0, a: '/xy', v: 0.9 }]),
            offset: 2,
            trimIn: 0,
            trimOut: 2
          }
        ]
      }
    ],
    edits: {
      'up.jsonl': {
        curves: [
          {
            port: PORT,
            a: '/xy',
            arg: 0,
            args: [0, 0],
            types: 'ff',
            knots: seg(2.5, 0.1, 3.5, 0.9)
          },
          {
            port: PORT,
            a: '/xy',
            arg: 1,
            args: [0, 0],
            types: 'ff',
            knots: seg(2.5, 0.2, 3.5, 0.8)
          }
        ]
      }
    }
  }
  const { events, curves } = mergeProject((f) => join(dir, f), project)
  expect(curves).toEqual([])
  // No piece is left to patch, so the resume still fires, with both args.
  expect(events[1]).toEqual({ t: 4.000001, port: PORT, a: '/xy', args: [0.9, 0.8], types: 'ff' })
})

test('a real event on the resume grid point suppresses the stale resume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'up.jsonl', [
              { t: 3, v: 0.3 }, // masked
              { t: 4.000001, v: 0.5 } // exactly where the resume would land
            ]),
            offset: 0,
            trimIn: 0,
            trimOut: 10
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [{ t: 0, v: 0.9 }]),
            offset: 2,
            trimIn: 0,
            trimOut: 2
          }
        ]
      }
    ]
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  // The track re-asserts itself: a resume beside it would sort last and
  // replay the masked 0.3.
  expect(shape(events)).toEqual([
    ['/a', 2, 0.9],
    ['/a', 4.000001, 0.5]
  ])
})

test('a real event one grid step past the resume leaves the resume alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'up.jsonl', [
              { t: 3, v: 0.3 },
              { t: 4.000002, v: 0.5 }
            ]),
            offset: 0,
            trimIn: 0,
            trimOut: 10
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [{ t: 0, v: 0.9 }]),
            offset: 2,
            trimIn: 0,
            trimOut: 2
          }
        ]
      }
    ]
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  expect(shape(events)).toEqual([
    ['/a', 2, 0.9],
    ['/a', 4.000001, 0.3],
    ['/a', 4.000002, 0.5]
  ])
})

test('masks are per (port, address): other addresses and ports pass through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'up.jsonl', [
              { t: 3, v: 0.3 },
              { t: 3, a: '/b', v: 0.31 },
              { t: 3, port: 10020, v: 0.32 }
            ]),
            offset: 0,
            trimIn: 0,
            trimOut: 10
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [{ t: 0, v: 0.9 }]),
            offset: 2,
            trimIn: 0,
            trimOut: 2
          }
        ]
      }
    ]
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  expect(events.map((e) => [e.a, e.port, e.t])).toEqual([
    ['/a', PORT, 2],
    ['/b', PORT, 3],
    ['/a', 10020, 3],
    ['/a', PORT, 4.000001] // resume of the masked /a on PORT only
  ])
})

test('a muted clip masks nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'up.jsonl', [
              { t: 2, v: 0.2 },
              { t: 3, v: 0.3 }
            ]),
            offset: 0,
            trimIn: 0,
            trimOut: 10
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [{ t: 0, v: 0.9 }]),
            offset: 2,
            trimIn: 0,
            trimOut: 2,
            muted: true
          }
        ]
      }
    ]
  }
  const { events, duration } = mergeProject((f) => join(dir, f), project)
  expect(shape(events)).toEqual([
    ['/a', 2, 0.2],
    ['/a', 3, 0.3]
  ])
  expect(duration).toBe(10)
})

test('three tracks stack: the bottom masks both above it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 't1.jsonl', [
              { t: 1, v: 0.1 },
              { t: 3, v: 0.3 },
              { t: 7, v: 0.7 }
            ]),
            offset: 0,
            trimIn: 0,
            trimOut: 10
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 't2.jsonl', [
              { t: 0.5, v: 0.25 },
              { t: 4.5, v: 0.65 }
            ]),
            offset: 2,
            trimIn: 0,
            trimOut: 6
          }
        ]
      },
      {
        clips: [
          { file: clipOf(dir, 't3.jsonl', [{ t: 0, v: 0.9 }]), offset: 6, trimIn: 0, trimOut: 1 }
        ]
      }
    ]
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  // Track 2's window [2, 8] masks track 1; track 3's [6, 7] masks both.
  expect(shape(events)).toEqual([
    ['/a', 1, 0.1],
    ['/a', 2.5, 0.25],
    ['/a', 6, 0.9],
    ['/a', 7.000001, 0.65], // track 2 resumes after track 3
    ['/a', 8.000001, 0.7] // track 1 resumes after track 2
  ])
})

test('trim and offset decide the mask: events land in it only once placed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'up.jsonl', [
              { t: 0, v: 0 },
              { t: 1, v: 0.1 },
              { t: 2, v: 0.2 },
              { t: 3, v: 0.3 }
            ]),
            // Local 1..3 → timeline 10..12; the local 0 event is trimmed off.
            offset: 10,
            trimIn: 1,
            trimOut: 3
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [{ t: 0, v: 0.9 }]),
            offset: 11,
            trimIn: 0,
            trimOut: 1
          }
        ]
      }
    ]
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  expect(shape(events)).toEqual([
    ['/a', 10, 0.1],
    ['/a', 11, 0.9],
    ['/a', 12.000001, 0.3]
  ])
})

test('no resume past the masked clip own window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'up.jsonl', [{ t: 1, v: 0.1 }]),
            offset: 0,
            trimIn: 0,
            trimOut: 3
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [{ t: 0, v: 0.9 }]),
            offset: 2,
            trimIn: 0,
            trimOut: 3
          }
        ]
      }
    ]
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  // The mask ends at 5, past the upper clip's end (3): nothing to resume.
  expect(shape(events)).toEqual([
    ['/a', 1, 0.1],
    ['/a', 2, 0.9]
  ])
})

test('a resume landing in the next mask window is suppressed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-merge-'))
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'up.jsonl', [{ t: 1, v: 0.1 }]),
            offset: 0,
            trimIn: 0,
            trimOut: 10
          }
        ]
      },
      // Two takes a sub-grid gap apart: the first mask ends at 4, the second
      // starts at 4.000001 — exactly where the first resume would land.
      {
        clips: [
          {
            file: clipOf(dir, 'take1.jsonl', [{ t: 0, v: 0.9 }]),
            offset: 2,
            trimIn: 0,
            trimOut: 2
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 'take2.jsonl', [{ t: 0, v: 0.8 }]),
            offset: 4.000001,
            trimIn: 0,
            trimOut: 1.999999
          }
        ]
      }
    ]
  }
  const { events } = mergeProject((f) => join(dir, f), project)
  // Only the second mask's end resumes the upper track; the first resume
  // would fire under take2.
  expect(shape(events)).toEqual([
    ['/a', 1, 0.1],
    ['/a', 2, 0.9],
    ['/a', 4.000001, 0.8],
    ['/a', 6.000001, 0.1]
  ])
})
