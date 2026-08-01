import { describe, expect, it } from 'vitest'
import { evalCurve } from '../../../shared/curve'
import type { ClipCurve, OscEvent } from '../../../shared/types'
import { buildCurveReplace, subtractCurveOverlap, type ReplaceInput } from './curveReplace'

function input(
  file: string,
  eventIndex: number,
  ev: Partial<OscEvent> & { t: number }
): ReplaceInput {
  return { file, eventIndex, ev: { port: 10010, a: '/x', args: [0], types: 'f', ...ev } }
}

function ramp(file: string, n: number, f: (t: number) => number): ReplaceInput[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    return input(file, i, { t, args: [f(t)] })
  })
}

describe('buildCurveReplace', () => {
  it('fits one curve per address arg and deletes the covered events', () => {
    const out = buildCurveReplace(ramp('a.jsonl', 20, (t) => t))!
    expect(out.adds).toHaveLength(1)
    const { curve } = out.adds[0]
    expect(curve.a).toBe('/x')
    expect(curve.arg).toBe(0)
    expect(evalCurve(curve.knots, 0.5)).toBeCloseTo(0.5, 2)
    expect(out.dels).toHaveLength(20)
    expect(out.dels[0]).toEqual({ file: 'a.jsonl', eventIndex: 0 })
  })

  it('fits every numeric arg of multi-arg events (sibling data survives)', () => {
    const inputs = Array.from({ length: 20 }, (_, i) => {
      const t = i / 19
      return input('a.jsonl', i, { a: '/xy', t, args: [t, 1 - t], types: 'ff' })
    })
    const out = buildCurveReplace(inputs)!
    expect(out.adds.map((a) => a.curve.arg).sort()).toEqual([0, 1])
    expect(evalCurve(out.adds[1].curve.knots, 0.25)).toBeCloseTo(0.75, 2)
    expect(out.dels).toHaveLength(20)
  })

  it('keeps events whose string args differ from the replayed template', () => {
    // The curve replays "a" (the template's string) for every sample, so
    // deleting the "b"/"c" events would silently rewrite their values.
    const inputs = Array.from({ length: 10 }, (_, i) => {
      const t = i / 9
      return input('a.jsonl', i, { a: '/mix', t, args: ['abc'[i % 3], t], types: 'sf' })
    })
    const out = buildCurveReplace(inputs)!
    expect(out.adds).toHaveLength(1)
    expect(out.adds[0].curve.args[0]).toBe('a')
    // Only the events matching the template ("a" at indices 0, 3, 6, 9) go.
    expect(out.dels.map((d) => d.eventIndex)).toEqual([0, 3, 6, 9])
  })

  it('skips non-numeric args and keeps the template intact', () => {
    const inputs = Array.from({ length: 10 }, (_, i) => {
      const t = i / 9
      return input('a.jsonl', i, { a: '/mix', t, args: ['cue', t], types: 'sf' })
    })
    const out = buildCurveReplace(inputs)!
    expect(out.adds).toHaveLength(1)
    expect(out.adds[0].curve.arg).toBe(1)
    expect(out.adds[0].curve.args).toEqual(['cue', 0])
    expect(out.adds[0].curve.types).toBe('sf')
  })

  it('groups per file and per address', () => {
    const out = buildCurveReplace([
      ...ramp('a.jsonl', 10, (t) => t),
      ...ramp('b.jsonl', 10, (t) => 1 - t)
    ])!
    expect(out.adds.map((a) => a.file).sort()).toEqual(['a.jsonl', 'b.jsonl'])
  })

  it('dedups an event selected through several properties', () => {
    const inputs = Array.from({ length: 10 }, (_, i) => {
      const t = i / 9
      return input('a.jsonl', i, { a: '/xy', t, args: [t, 1 - t], types: 'ff' })
    })
    const out = buildCurveReplace([...inputs, ...inputs])!
    expect(out.dels).toHaveLength(10)
  })

  it('templates each arg from an event that has it', () => {
    // Earliest event has one arg; the rest carry two.
    const inputs = [
      input('a.jsonl', 0, { a: '/xy', t: 0, args: [0], types: 'f' }),
      ...Array.from({ length: 19 }, (_, i) => {
        const t = (i + 1) / 19
        return input('a.jsonl', i + 1, { a: '/xy', t, args: [t, 1 - t], types: 'ff' })
      })
    ]
    const out = buildCurveReplace(inputs)!
    const arg1 = out.adds.find((a) => a.curve.arg === 1)!
    expect(arg1.curve.args).toHaveLength(2)
    expect(arg1.curve.types).toBe('ff')
  })

  it('keeps an event whose extra numeric arg cannot be fitted', () => {
    // e9 alone carries arg 1; one point can't span a curve, so deleting e9
    // would silently drop the 42.
    const inputs = [
      ...ramp('a.jsonl', 9, (t) => t),
      input('a.jsonl', 9, { t: 1, args: [1, 42], types: 'ff' })
    ]
    const out = buildCurveReplace(inputs)!
    expect(out.adds.map((a) => a.curve.arg)).toEqual([0])
    expect(out.dels).toHaveLength(9)
    expect(out.dels.some((d) => d.eventIndex === 9)).toBe(false)
  })

  it('returns null when nothing is fittable', () => {
    expect(buildCurveReplace([])).toBeNull()
    // A single event can't span a curve.
    expect(buildCurveReplace([input('a.jsonl', 0, { t: 0 })])).toBeNull()
    // All samples on one t collapse to a single point.
    expect(
      buildCurveReplace([
        input('a.jsonl', 0, { t: 1, args: [0] }),
        input('a.jsonl', 1, { t: 1, args: [1] })
      ])
    ).toBeNull()
  })
})

describe('subtractCurveOverlap', () => {
  const mk = (t0: number, t1: number, over: Partial<ClipCurve> = {}): ClipCurve => ({
    port: 10010,
    a: '/x',
    arg: 0,
    args: [0],
    types: 'f',
    knots: [
      { t: t0, v: 0 },
      { t: t1, v: 1 }
    ],
    ...over
  })

  it('splits a covering curve into left and right remainders', () => {
    const existing = mk(0, 10)
    const { dels, remainders } = subtractCurveOverlap([existing], mk(4, 6))
    expect(dels).toEqual([0])
    expect(remainders).toHaveLength(2)
    const [left, right] = remainders
    expect(left.knots[0].t).toBe(0)
    expect(left.knots[left.knots.length - 1].t).toBeCloseTo(4, 9)
    expect(right.knots[0].t).toBeCloseTo(6, 9)
    expect(right.knots[right.knots.length - 1].t).toBe(10)
    // Remainders trace the original.
    expect(evalCurve(left.knots, 2)).toBeCloseTo(evalCurve(existing.knots, 2), 9)
    expect(evalCurve(right.knots, 8)).toBeCloseTo(evalCurve(existing.knots, 8), 9)
  })

  it('drops a fully covered curve with no remainders', () => {
    const { dels, remainders } = subtractCurveOverlap([mk(4, 6)], mk(0, 10))
    expect(dels).toEqual([0])
    expect(remainders).toHaveLength(0)
  })

  it('ignores disjoint, deleted, and other-arg curves', () => {
    const { dels, remainders } = subtractCurveOverlap(
      [mk(0, 3), undefined, mk(0, 10, { arg: 1 }), mk(0, 10, { a: '/y' })],
      mk(4, 6)
    )
    expect(dels).toEqual([])
    expect(remainders).toHaveLength(0)
  })

  it('leaves adjacent (touching) curves alone', () => {
    const { dels } = subtractCurveOverlap([mk(0, 4)], mk(4, 6))
    expect(dels).toEqual([])
  })
})
