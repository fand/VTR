import { expect, test } from 'vitest'
import type { ClipEdits, CurveKnot } from '../../../shared/types'
import { applyMode, deriveMode, modePatches, selectionMode } from './curveMode'

const knots = (): CurveKnot[] => [
  { t: 0, v: 0, o: [0.3, 0.1] },
  { t: 1, v: 0.5, i: [-0.3, -0.1], o: [0.3, 0.1] },
  { t: 2, v: 1, i: [-0.3, -0.1] }
]

const doc = (ks: CurveKnot[] = knots()): Record<string, ClipEdits> => ({
  'a.jsonl': { curves: [{ port: 1, a: '/f', arg: 0, args: [0], knots: ks }] }
})

const knot = (knotIndex: number): { file: string; curveIndex: number; knotIndex: number } => ({
  file: 'a.jsonl',
  curveIndex: 0,
  knotIndex
})

test('deriveMode reads handle presence, ignoring sides with no segment', () => {
  const edits = doc()
  expect(deriveMode(knot(0), edits)).toBe('ease-out') // first knot: no in side
  expect(deriveMode(knot(1), edits)).toBe('ease-in-out')
  expect(deriveMode(knot(2), edits)).toBe('ease-in') // last knot: no out side
  expect(
    deriveMode(
      knot(1),
      doc([
        { t: 0, v: 0 },
        { t: 1, v: 1 },
        { t: 2, v: 0 }
      ])
    )
  ).toBe('linear')
})

test('deriveMode: step flag is const, dead handles do not count', () => {
  // Knot 0 steps: it reads const, and knot 1's incoming handle is dead.
  const edits = doc([
    { t: 0, v: 0, s: true, i: [-0.3, -0.1] },
    { t: 1, v: 0.5, i: [-0.3, -0.1] },
    { t: 2, v: 1, i: [-0.3, -0.1] }
  ])
  expect(deriveMode(knot(0), edits)).toBe('const')
  expect(deriveMode(knot(1), edits)).toBe('linear')
  // `s` on the last knot means nothing: it reads off its handles.
  const last = doc([
    { t: 0, v: 0 },
    { t: 1, v: 0.5 },
    { t: 2, v: 1, s: true }
  ])
  expect(deriveMode(knot(2), last)).toBe('linear')
})

test('deriveMode: event points are const, stale knot selections are null', () => {
  expect(deriveMode({ file: 'a.jsonl', eventIndex: 3, argIndex: 0 }, {})).toBe('const')
  expect(deriveMode(knot(0), {})).toBe(null)
  expect(deriveMode(knot(9), doc())).toBe(null)
  const deleted = doc()
  deleted['a.jsonl'].curveDel = { 0: true }
  expect(deriveMode(knot(0), deleted)).toBe(null)
})

test('selectionMode is the shared mode, null when mixed', () => {
  const edits = doc()
  expect(selectionMode([knot(1)], edits)).toBe('ease-in-out')
  expect(selectionMode([], edits)).toBe(null)
  // Stale members drop out instead of reading as mixed.
  expect(selectionMode([knot(1), knot(9)], edits)).toBe('ease-in-out')
  // Genuinely different modes: an eased knot and a linear one.
  const mixed = doc([
    { t: 0, v: 0, o: [0.3, 0.1] },
    { t: 1, v: 0.5 },
    { t: 2, v: 1, i: [-0.3, -0.1] }
  ])
  expect(selectionMode([knot(0), knot(1)], mixed)).toBe(null)
})

test('selectionMode reads a whole curve through its endpoints dead sides', () => {
  // Endpoints derive ease out / ease in, but the curve is ease in out
  // everywhere it can be — that is the one mode they all fit.
  const edits = doc()
  const all = [knot(0), knot(1), knot(2)]
  expect(selectionMode(all, edits)).toBe('ease-in-out')
  expect(selectionMode(all, doc(applyMode(knots(), [0, 1, 2], 'const')))).toBe('const')
  expect(selectionMode(all, doc(applyMode(knots(), [0, 1, 2], 'ease-out')))).toBe('ease-out')
  expect(selectionMode(all, doc(applyMode(knots(), [0, 1, 2], 'linear')))).toBe('linear')
})

test('applyMode const sets the step flag and drops the dead handles', () => {
  const out = applyMode(knots(), [1], 'const')
  expect(out[1]).toEqual({ t: 1, v: 0.5, i: [-0.3, -0.1], s: true }) // own `i` stays
  expect(out[2]).toEqual({ t: 2, v: 1 }) // next knot's `i` is dead
  expect(out[0]).toEqual(knots()[0]) // the previous knot is untouched
})

test('applyMode const on the last knot changes nothing', () => {
  expect(applyMode(knots(), [2], 'const')).toEqual(knots())
})

test('applyMode non-const clears its own and the previous step flag', () => {
  const stepped = applyMode(applyMode(knots(), [0], 'const'), [1], 'const')
  const out = applyMode(stepped, [1], 'linear')
  expect(out[0].s).toBeUndefined()
  expect(out[1].s).toBeUndefined()
  expect(out[1].i).toBeUndefined()
  expect(out[1].o).toBeUndefined()
})

test('applyMode keeps existing handles and defaults the missing ones flat', () => {
  // ease in → ease in out: the dragged `i` survives, only `o` is added.
  const out = applyMode(applyMode(knots(), [1], 'ease-in'), [1], 'ease-in-out')
  expect(out[1].i).toEqual([-0.3, -0.1])
  expect(out[1].o).toEqual([1 / 3, 0])
  // Sides with no segment are skipped: the first knot gets no `i`.
  const ends = applyMode(knots(), [0, 2], 'ease-in-out')
  expect(ends[0].i).toBeUndefined()
  expect(ends[0].o).toEqual([0.3, 0.1])
  expect(ends[2].o).toBeUndefined()
})

test('applyMode is idempotent', () => {
  for (const mode of ['const', 'linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
    const once = applyMode(knots(), [0, 1, 2], mode)
    expect(applyMode(once, [0, 1, 2], mode)).toEqual(once)
  }
})

test('applyMode ease-in after a step defaults the handle on the revived segment', () => {
  const out = applyMode(applyMode(knots(), [0], 'const'), [1], 'ease-in')
  expect(out[0].s).toBeUndefined()
  expect(out[1].i).toEqual([-1 / 3, 0])
})

test('modePatches emits one patch per curve and skips no-ops', () => {
  const edits = doc()
  const patches = modePatches([knot(0), knot(1), knot(2)], edits, 'const')
  expect(patches).toHaveLength(1)
  expect(patches[0]).toMatchObject({ file: 'a.jsonl', curveIndex: 0 })
  expect(patches[0].knots.map((k) => k.s === true)).toEqual([true, true, false])
  // Re-picking the mode a knot already has patches nothing.
  expect(modePatches([knot(1)], doc(), 'ease-in-out')).toEqual([])
  // Event points and stale knots contribute nothing on their own.
  expect(
    modePatches([{ file: 'a.jsonl', eventIndex: 0, argIndex: 0 }, knot(9)], edits, 'linear')
  ).toEqual([])
})
