import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clampHandleTimes,
  clipCurve,
  evalCurve,
  fitCurve,
  segmentCtrl,
  unshadowedPoints
} from './curve'
import type { CurveKnot } from './types'

describe('TS↔Rust parity', () => {
  it('evalCurve matches the golden fixture bit-for-bit', () => {
    // Shared with vtr-player's conformance_curve_eval.rs; see the fixture's
    // comment field for the regeneration rule.
    const raw = readFileSync(
      join(__dirname, '../../../vtr-player/tests/fixtures/curve_eval.json'),
      'utf8'
    )
    const fx = JSON.parse(raw) as {
      cases: { name: string; knots: CurveKnot[]; samples: number[]; expected: number[] }[]
    }
    expect(fx.cases.length).toBeGreaterThan(0)
    for (const c of fx.cases) {
      expect(c.samples.length).toBe(c.expected.length)
      c.samples.forEach((t, i) => {
        const got = evalCurve(c.knots, t)
        expect(Object.is(got, c.expected[i]), `${c.name} at t=${t}: got ${got}`).toBe(true)
      })
    }
  })
})

/** Max |evalCurve - v| over the samples. */
function maxError(knots: CurveKnot[], samples: { t: number; v: number }[]): number {
  let worst = 0
  for (const s of samples) {
    worst = Math.max(worst, Math.abs(evalCurve(knots, s.t) - s.v))
  }
  return worst
}

function sampleRamp(n: number, f: (t: number) => number): { t: number; v: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    return { t, v: f(t) }
  })
}

describe('evalCurve', () => {
  const linear: CurveKnot[] = [
    { t: 0, v: 0 },
    { t: 2, v: 1 }
  ]

  it('interpolates handle-less segments linearly', () => {
    expect(evalCurve(linear, 0.5)).toBeCloseTo(0.25, 6)
    expect(evalCurve(linear, 1)).toBeCloseTo(0.5, 6)
    expect(evalCurve(linear, 1.5)).toBeCloseTo(0.75, 6)
  })

  it('extends flat outside the span', () => {
    expect(evalCurve(linear, -5)).toBe(0)
    expect(evalCurve(linear, 5)).toBe(1)
  })

  it('respects handles (ease-in-out sits below linear early on)', () => {
    const eased: CurveKnot[] = [
      { t: 0, v: 0, o: [0.9, 0] },
      { t: 1, v: 1, i: [-0.9, 0] }
    ]
    expect(evalCurve(eased, 0.5)).toBeCloseTo(0.5, 6)
    expect(evalCurve(eased, 0.25)).toBeLessThan(0.25)
    expect(evalCurve(eased, 0.75)).toBeGreaterThan(0.75)
  })

  it('clamps a handle that would bend time backwards', () => {
    const bent: CurveKnot[] = [
      { t: 0, v: 0, o: [5, 0] }, // dt way past the 1s segment
      { t: 1, v: 1 }
    ]
    const [, p1] = segmentCtrl(bent[0], bent[1])
    expect(p1.x).toBe(1)
    // Still evaluates monotonically to the endpoints.
    expect(evalCurve(bent, 0)).toBe(0)
    expect(evalCurve(bent, 1)).toBe(1)
  })
})

describe('step segments', () => {
  const step: CurveKnot[] = [
    { t: 0, v: 0.2, s: true },
    { t: 1, v: 0.8 }
  ]

  it('holds the left value, jumping at the right knot', () => {
    expect(evalCurve(step, 0)).toBe(0.2)
    expect(evalCurve(step, 0.5)).toBe(0.2)
    expect(evalCurve(step, 0.999999)).toBe(0.2)
    expect(evalCurve(step, 1)).toBe(0.8)
  })

  it('ignores the dead handles on the held segment', () => {
    const dirty: CurveKnot[] = [
      { t: 0, v: 0.2, s: true, o: [0.9, 0.6] },
      { t: 1, v: 0.8, i: [-0.9, -0.6] }
    ]
    expect(evalCurve(dirty, 0.5)).toBe(0.2)
  })

  it('extends flat outside the span, s on the last knot inert', () => {
    expect(evalCurve(step, -5)).toBe(0.2)
    expect(evalCurve([...step.slice(0, 1), { t: 1, v: 0.8, s: true }], 5)).toBe(0.8)
  })

  it('mixes with bezier segments', () => {
    const mixed: CurveKnot[] = [
      { t: 0, v: 0 },
      { t: 1, v: 1, s: true },
      { t: 2, v: 0.5 },
      { t: 3, v: 1 }
    ]
    expect(evalCurve(mixed, 0.5)).toBeCloseTo(0.5, 6)
    expect(evalCurve(mixed, 1.5)).toBe(1)
    expect(evalCurve(mixed, 2)).toBeCloseTo(0.5, 9)
    expect(evalCurve(mixed, 2.5)).toBeCloseTo(0.75, 6)
  })

  it('keeps dead handles out of clampHandleTimes', () => {
    const knots: CurveKnot[] = [
      { t: 0, v: 0, s: true, o: [9, 9] },
      { t: 1, v: 1, i: [9, 9] }
    ]
    clampHandleTimes(knots)
    expect(knots[0].o).toEqual([9, 9])
    expect(knots[1].i).toEqual([9, 9])
  })
})

describe('fitCurve', () => {
  it('recovers a single cubic from clean samples', () => {
    // Monotone source: a peak would (rightly) become an extremum knot.
    const src: CurveKnot[] = [
      { t: 0, v: 0.1, o: [0.3, 0.2] },
      { t: 1, v: 0.8, i: [-0.3, -0.1] }
    ]
    const samples = sampleRamp(121, (t) => evalCurve(src, t))
    const knots = fitCurve(samples, 0.01)!
    expect(knots).toHaveLength(2)
    expect(knots[0].t).toBeCloseTo(0, 9)
    expect(knots[0].v).toBeCloseTo(0.1, 9)
    expect(knots[1].t).toBeCloseTo(1, 9)
    expect(knots[1].v).toBeCloseTo(0.8, 9)
    expect(maxError(knots, samples)).toBeLessThan(0.01)
  })

  it('fits a noisy ramp within tolerance and stays sparse', () => {
    // Deterministic pseudo-noise: no Math.random in tests.
    const samples = sampleRamp(120, (t) => t + 0.002 * Math.sin(t * 997))
    const knots = fitCurve(samples, 0.02)!
    expect(knots.length).toBeLessThan(10)
    expect(maxError(knots, samples)).toBeLessThan(0.03)
  })

  it('splits at a corner', () => {
    const samples = sampleRamp(81, (t) => Math.abs(t - 0.5))
    const knots = fitCurve(samples, 0.01)!
    expect(knots.length).toBeGreaterThanOrEqual(3)
    // The corner is an extremum, so a knot lands exactly on it.
    const nearest = Math.min(...knots.map((k) => Math.abs(k.t - 0.5)))
    expect(nearest).toBeLessThan(1e-9)
    expect(maxError(knots, samples)).toBeLessThan(0.02)
  })

  it('produces strictly increasing knot times with in-span handles', () => {
    const samples = sampleRamp(121, (t) => Math.sin(t * 7) * 0.5 + 0.5)
    const knots = fitCurve(samples, 0.005)!
    for (let i = 1; i < knots.length; i++) {
      expect(knots[i].t).toBeGreaterThan(knots[i - 1].t)
      const span = knots[i].t - knots[i - 1].t
      const o = knots[i - 1].o
      const inn = knots[i].i
      if (o) {
        expect(o[0]).toBeGreaterThanOrEqual(0)
        expect(o[0]).toBeLessThanOrEqual(span + 1e-9)
      }
      if (inn) {
        expect(inn[0]).toBeLessThanOrEqual(0)
        expect(inn[0]).toBeGreaterThanOrEqual(-span - 1e-9)
      }
    }
    expect(knots[0].i).toBeUndefined()
    expect(knots[knots.length - 1].o).toBeUndefined()
  })

  it('handles two points, duplicate times, and degenerate input', () => {
    // frame: Infinity — these are about fitting, not about step detection.
    const two = fitCurve(
      [
        { t: 0, v: 0 },
        { t: 1, v: 1 }
      ],
      0.01,
      Infinity
    )!
    expect(two).toHaveLength(2)
    expect(evalCurve(two, 0.5)).toBeCloseTo(0.5, 3)

    // Same-time duplicates collapse last-wins.
    const dup = fitCurve(
      [
        { t: 0, v: 9 },
        { t: 0, v: 0 },
        { t: 1, v: 1 }
      ],
      0.01,
      Infinity
    )!
    expect(dup[0].v).toBe(0)

    expect(fitCurve([{ t: 0, v: 1 }], 0.01)).toBeNull()
    expect(fitCurve([], 0.01)).toBeNull()
  })

  it('fits constant values flat', () => {
    const samples = sampleRamp(20, () => 0.5)
    const knots = fitCurve(samples, 0.01, Infinity)!
    expect(maxError(knots, samples)).toBeLessThan(1e-6)
  })
})

describe('fitCurve step detection', () => {
  it('ends a run with a step knot when the gap exceeds a frame', () => {
    const samples = [
      { t: 0, v: 0.2 },
      { t: 0.01, v: 0.2 },
      { t: 0.5, v: 0.8 },
      { t: 0.51, v: 0.8 }
    ]
    const knots = fitCurve(samples, 0.01)!
    const steps = knots.filter((k) => k.s)
    expect(steps).toHaveLength(1)
    expect(steps[0].t).toBeCloseTo(0.01, 9)
    // Hold across the gap, jump on the next run.
    expect(evalCurve(knots, 0.4)).toBeCloseTo(0.2, 9)
    expect(evalCurve(knots, 0.5)).toBeCloseTo(0.8, 9)
  })

  it('turns a train of isolated events into steps', () => {
    const samples = [0, 0.5, 1, 1.5].map((t, i) => ({ t, v: i / 3 }))
    const knots = fitCurve(samples, 0.01)!
    expect(knots).toHaveLength(4)
    expect(knots.map((k) => k.s ?? false)).toEqual([true, true, true, false])
    expect(evalCurve(knots, 0.4)).toBe(0)
    expect(evalCurve(knots, 1.4)).toBeCloseTo(2 / 3, 9)
  })
})

describe('fitCurve extrema', () => {
  it('keeps a peak exactly, with horizontal handles', () => {
    const samples = sampleRamp(201, (t) => Math.sin(t * Math.PI))
    const knots = fitCurve(samples, 0.05)!
    const peak = knots.find((k) => Math.abs(k.t - 0.5) < 1e-9)!
    expect(peak).toBeDefined()
    expect(peak.v).toBe(1)
    expect(peak.i![1]).toBeCloseTo(0, 12)
    expect(peak.o![1]).toBeCloseTo(0, 12)
  })

  it('ignores jitter under the hysteresis band', () => {
    // Non-monotone, but every retreat is well under the 0.03 band.
    const samples = sampleRamp(241, (t) => t * 0.5 + 0.003 * Math.sin(t * 100))
    const knots = fitCurve(samples, 0.05)!
    expect(knots).toHaveLength(2)
  })

  it('keeps a shallow peak even when the tolerance is loose', () => {
    // Prominence ~0.1 of range: under the 0.1 tolerance, over the 0.03 band.
    const shallow = (t: number): number =>
      t < 0.5 ? t : t < 0.6 ? 0.5 - (t - 0.5) * 0.8 : 0.42 + (t - 0.6)
    const knots = fitCurve(sampleRamp(241, shallow), 0.1)!
    expect(knots.some((k) => Math.abs(k.t - 0.5) < 1e-9 && k.v === 0.5)).toBe(true)
  })

  it('keeps a peak near the end of the data', () => {
    // Only falls 0.05 past the peak before the data stops.
    const late = (t: number): number => (t < 0.9 ? t / 0.9 : 1 - (t - 0.9) * 0.5)
    const knots = fitCurve(sampleRamp(241, late), 0.1)!
    expect(knots.some((k) => Math.abs(k.t - 0.9) < 1e-9 && k.v === 1)).toBe(true)
  })

  it('still splits a monotone segment when the speed profile misses tolerance', () => {
    const smooth = (u: number): number => u * u * (3 - 2 * u)
    const ease = (t: number): number => smooth(Math.min(Math.max((t - 0.4) / 0.2, 0), 1))
    const samples = sampleRamp(241, ease)
    const knots = fitCurve(samples, 0.01)!
    // No extremum here: flat → fast → flat is monotone, the error drives it.
    expect(knots.length).toBeGreaterThan(2)
    expect(maxError(knots, samples)).toBeLessThan(0.02)
  })
})

describe('clipCurve', () => {
  const src: CurveKnot[] = [
    { t: 0, v: 0, o: [0.4, 0.8] },
    { t: 1, v: 1, i: [-0.2, 0.1], o: [0.3, -0.1] },
    { t: 2, v: 0, i: [-0.4, 0.6] }
  ]

  it('is a no-op for a covering window', () => {
    const out = clipCurve(src, -1, 3)!
    expect(out).toEqual(src)
  })

  it('splits boundary segments and traces the original exactly', () => {
    const out = clipCurve(src, 0.25, 1.6)!
    expect(out[0].t).toBeCloseTo(0.25, 9)
    expect(out[out.length - 1].t).toBeCloseTo(1.6, 9)
    for (let i = 0; i <= 40; i++) {
      const t = 0.25 + (i / 40) * (1.6 - 0.25)
      expect(evalCurve(out, t)).toBeCloseTo(evalCurve(src, t), 6)
    }
    // Clip boundaries drop the outward handles.
    expect(out[0].i).toBeUndefined()
    expect(out[out.length - 1].o).toBeUndefined()
  })

  it('drops fully-outside segments', () => {
    const out = clipCurve(src, 1.2, 5)!
    expect(out).toHaveLength(2)
    expect(out[0].t).toBeCloseTo(1.2, 9)
    expect(out[1].t).toBeCloseTo(2, 9)
  })

  it('returns null when nothing overlaps', () => {
    expect(clipCurve(src, 3, 4)).toBeNull()
    expect(clipCurve(src, -2, -1)).toBeNull()
    expect(clipCurve(src, 0.5, 0.5)).toBeNull()
  })

  it('splits inside a step segment by holding, not by de Casteljau', () => {
    const step: CurveKnot[] = [
      { t: 0, v: 0.2, s: true },
      { t: 2, v: 0.8 }
    ]
    expect(clipCurve(step, 0.5, 1.5)).toEqual([
      { t: 0.5, v: 0.2, s: true },
      { t: 1.5, v: 0.2 }
    ])
  })

  const mixed: CurveKnot[] = [
    { t: 0, v: 0, o: [0.3, 0.2] },
    { t: 1, v: 1, i: [-0.3, -0.2], s: true },
    { t: 2, v: 0.25, s: true },
    { t: 3, v: 0.75 }
  ]

  it('keeps an interior step knot when the clip splits the segment before it', () => {
    const out = clipCurve(mixed, 0.5, 2.5)!
    expect(out.map((k) => k.s ?? false)).toEqual([false, true, true, false])
    expect(out[1].t).toBeCloseTo(1, 9)
    // The incoming handle of a step knot belongs to the bezier before it.
    expect(out[1].i).toBeDefined()
    for (let i = 0; i <= 40; i++) {
      const t = 0.5 + (i / 40) * 2
      expect(evalCurve(out, t)).toBeCloseTo(evalCurve(mixed, t), 6)
    }
  })

  it('strips s from the last knot when the window ends on a step knot', () => {
    // `s` on a last knot means nothing (the flat extension holds anyway):
    // clips come out canonical, same rule as deletePoints.
    const out = clipCurve(mixed, 0.5, 2)!
    expect(out[out.length - 1].t).toBeCloseTo(2, 9)
    expect(out[out.length - 1].s).toBeUndefined()
  })
})

describe('unshadowedPoints', () => {
  it('drops points at or inside a span, ends inclusive', () => {
    const pts = [1, 2, 3, 4, 5].map((t) => ({ t }))
    const out = unshadowedPoints(pts, [{ start: 2, end: 4 }])
    expect(out.map((p) => p.t)).toEqual([1, 5])
  })

  it('keeps everything when there are no spans', () => {
    const pts = [{ t: 1 }, { t: 2 }]
    expect(unshadowedPoints(pts, [])).toEqual(pts)
  })

  it('checks every span, not just the first', () => {
    const pts = [0.5, 1.5, 2.5].map((t) => ({ t }))
    const out = unshadowedPoints(pts, [
      { start: 0, end: 1 },
      { start: 2, end: 3 }
    ])
    expect(out.map((p) => p.t)).toEqual([1.5])
  })
})
