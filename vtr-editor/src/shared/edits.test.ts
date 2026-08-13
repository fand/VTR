import { expect, test } from 'vitest'
import { applyEditsIndexed, editsEmpty } from './edits'
import type { OscEvent } from './types'

const ev = (t: number, args: unknown[] = [0]): OscEvent => ({ t, port: 1, a: '/x', args })

test('editsEmpty: absent, empty containers, and each non-empty kind', () => {
  expect(editsEmpty(undefined)).toBe(true)
  expect(editsEmpty({})).toBe(true)
  expect(editsEmpty({ set: {}, del: {}, add: [], curves: [] })).toBe(true)
  expect(editsEmpty({ set: { 0: { t: 1 } } })).toBe(false)
  expect(editsEmpty({ del: { 0: true } })).toBe(false)
  expect(editsEmpty({ add: [ev(0)] })).toBe(false)
  // Curves alone keep the sidecar alive (they ride the same overlay).
  expect(
    editsEmpty({
      curves: [
        {
          port: 1,
          a: '/x',
          arg: 0,
          args: [0],
          knots: [
            { t: 0, v: 0 },
            { t: 1, v: 1 }
          ]
        }
      ]
    })
  ).toBe(false)
})

test('set/del reach added events via keys past the original count', () => {
  const events = [ev(0), ev(1)]
  const out = applyEditsIndexed(events, {
    add: [ev(2, [5]), ev(3, [6])],
    // Index 2 = first added event; move it and patch its arg.
    set: { 2: { t: 9, args: { 0: 50 } } },
    // Index 3 = second added event; delete it.
    del: { 3: true }
  })
  expect(out.map((x) => x.idx)).toEqual([0, 1, 2])
  const moved = out.find((x) => x.idx === 2)!
  expect(moved.ev.t).toBe(9)
  expect(moved.ev.args).toEqual([50])
})

test('a t edit re-sorts events by time', () => {
  const out = applyEditsIndexed([ev(0), ev(1)], { set: { 0: { t: 5 } } })
  expect(out.map((x) => x.idx)).toEqual([1, 0])
})

// --- Overlay transforms -----------------------------------------------------

import {
  addPoints,
  applyPointPatches,
  deletePoints,
  replaceWithCurves,
  type PointSel
} from './edits'
import type { ClipCurve, ClipEdits } from './types'

const curve = (t0: number, t1: number, over: Partial<ClipCurve> = {}): ClipCurve => ({
  port: 1,
  a: '/x',
  arg: 0,
  args: [0],
  knots: [
    { t: t0, v: 0 },
    { t: t1, v: 1 }
  ],
  ...over
})

test('applyPointPatches: event t/value edits land in set; curve patch swaps knots', () => {
  const edits: Record<string, ClipEdits> = {
    'a.jsonl': { curves: [curve(0, 4)] }
  }
  applyPointPatches(edits, [
    { file: 'a.jsonl', eventIndex: 2, t: 1.5, argIndex: 0, value: 0.25 },
    { file: 'a.jsonl', eventIndex: 2, t: 2.5 }, // second patch merges into the same entry
    {
      file: 'a.jsonl',
      curveIndex: 0,
      knots: [
        { t: 0, v: 0 },
        { t: 9, v: 9 }
      ]
    }
  ])
  expect(edits['a.jsonl'].set).toEqual({ 2: { t: 2.5, args: { 0: 0.25 } } })
  expect(edits['a.jsonl'].curves![0].knots[1]).toEqual({ t: 9, v: 9 })
})

test('applyPointPatches: a patch for a vanished curve is skipped, not resurrected', () => {
  const edits: Record<string, ClipEdits> = {}
  applyPointPatches(edits, [{ file: 'a.jsonl', curveIndex: 3, knots: [] }])
  expect(edits['a.jsonl'].curves).toBeUndefined()
})

test('addPoints appends to each file overlay in order', () => {
  const edits: Record<string, ClipEdits> = { 'a.jsonl': { add: [ev(0)] } }
  addPoints(edits, [
    { file: 'a.jsonl', ev: ev(1) },
    { file: 'b.jsonl', ev: ev(2) }
  ])
  expect(edits['a.jsonl'].add!.map((e) => e.t)).toEqual([0, 1])
  expect(edits['b.jsonl'].add!.map((e) => e.t)).toEqual([2])
})

test('deletePoints: event dels flag, knot dels rebuild the curve', () => {
  const edits: Record<string, ClipEdits> = {
    'a.jsonl': {
      curves: [
        {
          ...curve(0, 3),
          knots: [
            { t: 0, v: 0, o: [1, 0] },
            { t: 1, v: 1, i: [-0.2, 0], o: [0.2, 0] },
            { t: 2, v: 0, i: [-0.2, 0], o: [0.2, 0] },
            { t: 3, v: 1, i: [-1, 0] }
          ]
        }
      ]
    }
  }
  const sels: PointSel[] = [
    { file: 'a.jsonl', eventIndex: 7, argIndex: 0 },
    { file: 'a.jsonl', curveIndex: 0, knotIndex: 0 },
    { file: 'a.jsonl', curveIndex: 0, knotIndex: 2 }
  ]
  deletePoints(edits, sels)
  expect(edits['a.jsonl'].del).toEqual({ 7: true })
  const knots = edits['a.jsonl'].curves![0].knots
  expect(knots.map((k) => k.t)).toEqual([1, 3])
  // New boundary knots keep only their inward handles.
  expect(knots[0].i).toBeUndefined()
  expect(knots[0].o).toEqual([0.2, 0])
  expect(knots[1].i).toEqual([-1, 0])
  expect(knots[1].o).toBeUndefined()
})

test('deletePoints: a curve left with fewer than 2 knots is dropped via curveDel', () => {
  const edits: Record<string, ClipEdits> = { 'a.jsonl': { curves: [curve(0, 1)] } }
  deletePoints(edits, [{ file: 'a.jsonl', curveIndex: 0, knotIndex: 1 }])
  expect(edits['a.jsonl'].curveDel).toEqual({ 0: true })
  // Knots untouched: the drop is the whole delete.
  expect(edits['a.jsonl'].curves![0].knots).toHaveLength(2)
})

test('deletePoints: a new last knot loses its step flag', () => {
  const edits: Record<string, ClipEdits> = {
    'a.jsonl': {
      curves: [
        {
          ...curve(0, 2),
          knots: [
            { t: 0, v: 0 },
            { t: 1, v: 1, s: true },
            { t: 2, v: 0 }
          ]
        }
      ]
    }
  }
  deletePoints(edits, [{ file: 'a.jsonl', curveIndex: 0, knotIndex: 2 }])
  const knots = edits['a.jsonl'].curves![0].knots
  expect(knots.map((k) => k.t)).toEqual([0, 1])
  expect(knots[1].s).toBeUndefined()
})

test('replaceWithCurves: dels flag events; a new curve carves overlapping same-arg curves', () => {
  const edits: Record<string, ClipEdits> = {
    'a.jsonl': { curves: [curve(0, 10), curve(0, 1, { arg: 1 })] }
  }
  replaceWithCurves(
    edits,
    [{ file: 'a.jsonl', eventIndex: 4 }],
    [{ file: 'a.jsonl', curve: curve(2, 5) }]
  )
  const ce = edits['a.jsonl']
  expect(ce.del).toEqual({ 4: true })
  // The overlapped same-arg curve is deleted; its left/right remainders and
  // the new curve are appended (other-arg curve untouched).
  expect(ce.curveDel).toEqual({ 0: true })
  const spans = ce.curves!.map((c) => [c.knots[0].t, c.knots[c.knots.length - 1].t])
  const want = [
    [0, 10],
    [0, 1],
    [0, 2], // left remainder: split t comes from a bisection, so ~exact
    [5, 10],
    [2, 5]
  ]
  expect(spans.length).toBe(want.length)
  spans.forEach((s, i) => {
    expect(s[0]).toBeCloseTo(want[i][0], 9)
    expect(s[1]).toBeCloseTo(want[i][1], 9)
  })
})
