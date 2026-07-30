import { expect, test } from 'vitest'
import type { CurveKnot } from '../../../shared/types'
import { KNOT_GAP, applyKnotMoves, setKnotHandle } from './curveEdit'

const knots = (): CurveKnot[] => [
  { t: 0, v: 0, o: [0.3, 0.1] },
  { t: 1, v: 0.5, i: [-0.3, -0.1], o: [0.3, 0.1] },
  { t: 2, v: 1, i: [-0.3, -0.1] }
]

test('applyKnotMoves moves t/v and leaves the rest untouched', () => {
  const out = applyKnotMoves(knots(), new Map([[1, { t: 1.2, v: 0.7 }]]))
  expect(out[1]).toMatchObject({ t: 1.2, v: 0.7, i: [-0.3, -0.1], o: [0.3, 0.1] })
  expect(out[0]).toEqual(knots()[0])
  expect(out[2]).toEqual(knots()[2])
})

test('applyKnotMoves clamps a knot between its unmoved neighbors', () => {
  // Past the right neighbor: stops one gap short of it.
  let out = applyKnotMoves(knots(), new Map([[1, { t: 5, v: 0.5 }]]))
  expect(out[1].t).toBeCloseTo(2 - KNOT_GAP, 12)
  expect(out[2].t).toBe(2)
  // Past the left neighbor: same on the other side.
  out = applyKnotMoves(knots(), new Map([[1, { t: -5, v: 0.5 }]]))
  expect(out[1].t).toBeCloseTo(0 + KNOT_GAP, 12)
  expect(out[0].t).toBe(0)
})

test('applyKnotMoves keeps order for a group translate', () => {
  const out = applyKnotMoves(
    knots(),
    new Map([
      [0, { t: 0.5, v: 0 }],
      [1, { t: 1.5, v: 0.5 }],
      [2, { t: 2.5, v: 1 }]
    ])
  )
  expect(out.map((k) => k.t)).toEqual([0.5, 1.5, 2.5])
})

test('applyKnotMoves re-clamps handles when a segment shrinks', () => {
  // Middle knot dragged near the right knot: the handles on the shrunken
  // 0.1s segment (its o, the right knot's i) scale down, direction kept.
  const out = applyKnotMoves(knots(), new Map([[1, { t: 1.9, v: 0.5 }]]))
  expect(out[1].i).toEqual([-0.3, -0.1]) // left segment grew: untouched
  expect(out[1].o![0]).toBeCloseTo(0.1, 9)
  expect(out[1].o![1]).toBeCloseTo((0.1 * 0.1) / 0.3, 9)
  expect(out[2].i![0]).toBeCloseTo(-0.1, 9)
  expect(out[2].i![1]).toBeCloseTo((-0.1 * -0.1) / -0.3, 9)
})

test('setKnotHandle sets and clamps the outgoing handle', () => {
  const out = setKnotHandle(knots(), 0, 'o', 0.5, 0.2)
  expect(out[0].o).toEqual([0.5, 0.2])
  // dt clamps into the segment: negative → 0, past the neighbor → span.
  expect(setKnotHandle(knots(), 0, 'o', -1, 0.2)[0].o).toEqual([0, 0.2])
  expect(setKnotHandle(knots(), 0, 'o', 9, 0.2)[0].o).toEqual([1, 0.2])
})

test('setKnotHandle sets and clamps the incoming handle', () => {
  const out = setKnotHandle(knots(), 2, 'i', -0.5, 0.2)
  expect(out[2].i).toEqual([-0.5, 0.2])
  expect(setKnotHandle(knots(), 2, 'i', 1, 0.2)[2].i).toEqual([0, 0.2])
  expect(setKnotHandle(knots(), 2, 'i', -9, 0.2)[2].i).toEqual([-1, 0.2])
})

test('setKnotHandle without a neighbor on that side is a noop', () => {
  expect(setKnotHandle(knots(), 0, 'i', -0.5, 0.2)).toEqual(knots())
  expect(setKnotHandle(knots(), 2, 'o', 0.5, 0.2)).toEqual(knots())
})
