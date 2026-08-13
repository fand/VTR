import { expect, test } from 'vitest'
import { subtractCurveOverlap, type EventPointSel } from '../../../shared/edits'
import type { ClipCurve, CurveKnot, OscEvent } from '../../../shared/types'
import {
  buildPointConversion,
  isRefusal,
  type ConvertCtx,
  type PointConversion
} from './curveConvert'

const F = 'a.jsonl'
const PORT = 9000

const ev = (t: number, args: unknown[], a = '/f'): OscEvent => ({ t, port: PORT, a, args })

const curve = (knots: CurveKnot[], arg = 0, a = '/f'): ClipCurve => ({
  port: PORT,
  a,
  arg,
  args: [0],
  knots
})

const ctxOf = (events: OscEvent[], curves: ClipCurve[] = []): ConvertCtx => ({
  events: events.map((e, i) => ({ file: F, eventIndex: i, ev: e })),
  curves: curves.map((c, i) => ({ file: F, curveIndex: i, curve: c }))
})

const sel = (eventIndex: number, argIndex = 0): EventPointSel => ({ file: F, eventIndex, argIndex })

/** Points at t = 0..n-1, value = t/10. */
const ramp = (n: number): OscEvent[] => Array.from({ length: n }, (_, i) => ev(i, [i / 10]))

const ok = (r: ReturnType<typeof buildPointConversion>): PointConversion => {
  expect(r).not.toBeNull()
  expect(isRefusal(r)).toBe(false)
  return r as PointConversion
}

test('one selected point pulls in one element on each side', () => {
  const r = ok(buildPointConversion([sel(2)], ctxOf(ramp(5)), 'ease-in-out'))
  expect(r.adds).toHaveLength(1)
  expect(r.adds[0].curve.knots.map((k) => k.t)).toEqual([1, 2, 3])
  // Only the selected knot gets handles; the pulled-in ones stay plain.
  expect(r.adds[0].curve.knots[1].i).toBeDefined()
  expect(r.adds[0].curve.knots[1].o).toBeDefined()
  expect(r.adds[0].curve.knots[0].o).toBeUndefined()
  expect(r.adds[0].curve.knots[2].i).toBeUndefined()
  // Every covered event goes, so the span holds no live event.
  expect(r.dels.map((d) => d.eventIndex).sort()).toEqual([1, 2, 3])
})

test('runs sharing an element merge into one curve, absorbing what is between', () => {
  // Points [a, b, c] with a and c selected: one curve, b a plain knot.
  const r = ok(buildPointConversion([sel(0), sel(2)], ctxOf(ramp(3)), 'ease-in'))
  expect(r.adds).toHaveLength(1)
  expect(r.adds[0].curve.knots.map((k) => k.t)).toEqual([0, 1, 2])
  expect(r.adds[0].curve.knots[1].i).toBeUndefined()
  expect(r.adds[0].curve.knots[2].i).toBeDefined()
  expect(r.dels).toHaveLength(3)
})

test('separate runs stay separate curves and leave the gap alone', () => {
  // Points 0..4 with 0 and 4 selected: two curves, the middle point lives.
  const r = ok(buildPointConversion([sel(0), sel(4)], ctxOf(ramp(5)), 'ease-in-out'))
  expect(r.adds.map((a) => a.curve.knots.map((k) => k.t))).toEqual([
    [0, 1],
    [3, 4]
  ])
  expect(r.dels.map((d) => d.eventIndex).sort()).toEqual([0, 1, 3, 4])
})

test('a boundary curve endpoint joins instead of a farther point', () => {
  const existing = curve([
    { t: 0, v: 0, o: [0.3, 0] },
    { t: 1, v: 1, s: true }
  ])
  const later = curve([
    { t: 3, v: 1 },
    { t: 4, v: 0 }
  ])
  // The point at t=2 has curves on both sides and no nearer point.
  const r = ok(buildPointConversion([sel(0)], ctxOf([ev(2, [0.5])], [existing, later]), 'linear'))
  expect(r.adds).toHaveLength(1)
  const knots = r.adds[0].curve.knots
  expect(knots.map((k) => k.t)).toEqual([0, 1, 2, 3, 4])
  // The junction's step is cleared: its segment toward the run interpolates.
  expect(knots[1].s).toBeUndefined()
  expect(knots[0].o).toEqual([0.3, 0])
  expect(r.dels).toEqual([{ file: F, eventIndex: 0 }])
})

test('a joined curve is fully covered, so the carving leaves no remainder', () => {
  const existing = curve([
    { t: 0, v: 0 },
    { t: 1, v: 1 }
  ])
  const r = ok(buildPointConversion([sel(0)], ctxOf([ev(2, [0.5])], [existing]), 'ease-out'))
  const cut = subtractCurveOverlap([existing], r.adds[0].curve)
  expect(cut.dels).toEqual([0])
  expect(cut.remainders).toEqual([])
})

test('a point inside a curve span splits the segment instead', () => {
  const existing = curve([
    { t: 0, v: 0 },
    { t: 2, v: 1 }
  ])
  const r = ok(buildPointConversion([sel(0)], ctxOf([ev(1, [0.25])], [existing]), 'ease-in-out'))
  expect(r.adds).toHaveLength(1)
  const knots = r.adds[0].curve.knots
  expect(knots.map((k) => k.t)).toEqual([0, 1, 2])
  expect(knots[1].v).toBe(0.25) // the point's own value
  expect(knots[1].i).toBeDefined()
  expect(knots[1].o).toBeDefined()
  expect(r.dels).toEqual([{ file: F, eventIndex: 0 }])
  // Same span as the original, so it replaces it outright.
  expect(subtractCurveOverlap([existing], r.adds[0].curve)).toEqual({ dels: [0], remainders: [] })
})

test('sibling numeric args get their own curves and stay discrete', () => {
  const events = [ev(0, [0, 10]), ev(1, [0.1, 20]), ev(2, [0.2, 30])]
  const r = ok(buildPointConversion([sel(1)], ctxOf(events), 'ease-in-out'))
  expect(r.adds.map((a) => a.curve.arg)).toEqual([0, 1])
  const sibling = r.adds[1].curve.knots
  expect(sibling.map((k) => [k.t, k.v])).toEqual([
    [0, 10],
    [1, 20],
    [2, 30]
  ])
  // Step on every non-last knot: the values still jump exactly as events did.
  expect(sibling.map((k) => k.s === true)).toEqual([true, true, false])
  expect(sibling.every((k) => !k.i && !k.o)).toBe(true)
  // Both curves replay the same template.
  expect(r.adds[0].curve.args).toEqual([0, 10])
})

test('same-t events dedup last-wins and all of them are deleted', () => {
  const events = [ev(0, [0]), ev(1, [0.5]), ev(1, [0.7]), ev(2, [1])]
  const r = ok(buildPointConversion([sel(1), sel(2)], ctxOf(events), 'linear'))
  const knots = r.adds[0].curve.knots
  expect(knots.map((k) => k.t)).toEqual([0, 1, 2])
  expect(knots[1].v).toBe(0.7)
  expect(r.dels).toHaveLength(4)
})

test('an event that the template cannot replay refuses the whole op', () => {
  const events = [ev(0, [0, 'a']), ev(1, [0.5, 'a']), ev(2, [1, 'b'])]
  const r = buildPointConversion([sel(1)], ctxOf(events), 'ease-in-out')
  expect(isRefusal(r)).toBe(true)
  expect(isRefusal(r) && r.refusal).toMatch(/arg 1/)
})

test('a sibling arg with nothing to join refuses instead of losing its values', () => {
  // The run joins the arg-0 curve on its left, but arg 1 has no curve
  // ending there — its lone knot is no curve, and the event goes away.
  const existing = curve([
    { t: 1, v: 0 },
    { t: 3, v: 1 }
  ])
  const r = buildPointConversion([sel(0)], ctxOf([ev(5, [0.5, 42])], [existing]), 'ease-in-out')
  expect(isRefusal(r)).toBe(true)
  expect(isRefusal(r) && r.refusal).toMatch(/arg 1 would be left with a single knot/)
})

test('a span that would swallow another arg curve refuses', () => {
  // The arg-0 run spans 1..5; the arg-1 curve sits strictly inside it, so
  // the new arg-1 curve would carve away a hand-edited one.
  const inner = curve(
    [
      { t: 2, v: 0 },
      { t: 4, v: 1 }
    ],
    1
  )
  const events = [ev(1, [0, 10]), ev(5, [1, 50])]
  const r = buildPointConversion([sel(0), sel(1)], ctxOf(events, [inner]), 'ease-in-out')
  expect(isRefusal(r)).toBe(true)
  expect(isRefusal(r) && r.refusal).toMatch(/arg 1 curve at 2–4s/)
})

test('a lone point with no neighbor element converts nothing', () => {
  expect(buildPointConversion([sel(0)], ctxOf([ev(1, [0.5])]), 'ease-in-out')).toBeNull()
  // const is what a discrete point already is.
  expect(buildPointConversion([sel(2)], ctxOf(ramp(5)), 'const')).toBeNull()
  // A stale selection resolves to nothing.
  expect(buildPointConversion([sel(9)], ctxOf(ramp(5)), 'linear')).toBeNull()
})

test('no live event is left inside an added span', () => {
  const events = [...ramp(5), ev(1.5, [9], '/other')]
  const r = ok(buildPointConversion([sel(0), sel(2)], ctxOf(events), 'ease-in-out'))
  const deleted = new Set(r.dels.map((d) => d.eventIndex))
  events.forEach((e, i) => {
    const inside = r.adds.some(
      (add) =>
        add.curve.a === e.a &&
        add.curve.port === e.port &&
        add.curve.knots[0].t <= e.t &&
        e.t <= add.curve.knots[add.curve.knots.length - 1].t
    )
    expect(inside && !deleted.has(i)).toBe(false)
  })
  // The other address is untouched.
  expect(deleted.has(5)).toBe(false)
})
