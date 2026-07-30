import { describe, expect, it } from 'vitest'
import { evalCurve } from '../../../shared/curve'
import type { OscEvent } from '../../../shared/types'
import { buildCurveReplace, type ReplaceInput } from './curveReplace'

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
