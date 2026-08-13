import { describe, expect, it } from 'vitest'
import { evalCurve } from './curve'
import {
  carveKnots,
  clipKeys,
  dropMasked,
  liveCurves,
  maskIntervals,
  maskKey,
  resumeEvent,
  round6
} from './trackMask'
import type { MaskClip } from './trackMask'
import type { ClipCurve, CurveKnot, OscEvent } from './types'

const PORT = 10010

function ev(t: number, a: string, args: number[], port = PORT): OscEvent {
  return { t, port, a, args, types: 'f'.repeat(args.length) }
}

function curve(a: string, knots: CurveKnot[], opts: Partial<ClipCurve> = {}): ClipCurve {
  return { port: PORT, a, arg: 0, args: [0], types: 'f', knots, ...opts }
}

/** The spec's example curve: a straight 0→1 ramp over [0, 10]. */
const ramp: CurveKnot[] = [
  { t: 0, v: 0 },
  { t: 10, v: 1 }
]

const win = (start: number, end: number, ...keys: string[]): MaskClip => ({
  start,
  end,
  keys: new Set(keys)
})

const KA = maskKey(PORT, '/a')

describe('clipKeys', () => {
  it('collects keys of events inside the trim only', () => {
    const events = [ev(0.5, '/a', [1]), ev(5, '/b', [1])]
    expect([...clipKeys(events, undefined, 0, 2)]).toEqual([KA])
  })

  it('keys on (port, address), so two ports stay apart', () => {
    const events = [ev(1, '/a', [1]), ev(1, '/a', [1], 10020)]
    expect(clipKeys(events, undefined, 0, 2)).toEqual(new Set([KA, maskKey(10020, '/a')]))
  })

  it('adds curves that overlap the trim, skipping touching-only and deleted ones', () => {
    const edits = {
      curves: [
        curve('/c', [
          { t: 1, v: 0 },
          { t: 3, v: 1 }
        ]),
        // Touches trimOut exactly: places nothing, so it carries nothing.
        curve('/d', [
          { t: 2, v: 0 },
          { t: 4, v: 1 }
        ]),
        curve('/e', [
          { t: 0, v: 0 },
          { t: 1, v: 1 }
        ])
      ],
      curveDel: { 2: true as const }
    }
    expect(liveCurves(edits).map((c) => c.a)).toEqual(['/c', '/d'])
    expect(clipKeys([], edits, 0, 2)).toEqual(new Set([maskKey(PORT, '/c')]))
  })
})

describe('maskIntervals', () => {
  it('masks the track above with the lower track window (spec example)', () => {
    const out = maskIntervals([[win(0, 10, KA)], [win(2, 4, KA)]])
    expect(out[0].get(KA)).toEqual([{ start: 2, end: 4 }])
    // The bottom track is masked by nobody.
    expect(out[1].size).toBe(0)
  })

  it('scopes masks per key: an unrelated address is untouched', () => {
    const out = maskIntervals([[win(0, 10, KA)], [win(2, 4, maskKey(PORT, '/b'))]])
    expect(out[0].get(KA)).toBeUndefined()
    expect(out[0].get(maskKey(PORT, '/b'))).toEqual([{ start: 2, end: 4 }])
  })

  it('stacks bottom-up: track 3 masks 1 and 2, track 2 masks 1', () => {
    const out = maskIntervals([[win(0, 10, KA)], [win(1, 3, KA)], [win(5, 6, KA)]])
    expect(out[0].get(KA)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 }
    ])
    expect(out[1].get(KA)).toEqual([{ start: 5, end: 6 }])
    expect(out[2].size).toBe(0)
  })

  it('merges overlapping and touching windows across lower tracks', () => {
    const out = maskIntervals([
      [win(0, 20, KA)],
      [win(2, 4, KA), win(8, 9, KA)],
      [win(3, 6, KA), win(6, 7, KA)]
    ])
    expect(out[0].get(KA)).toEqual([
      { start: 2, end: 7 },
      { start: 8, end: 9 }
    ])
  })

  it('ignores muted clips, which the caller leaves out of the track list', () => {
    // Muted clips still occupy the timeline for duration, but they never mask,
    // so callers simply don't pass them here.
    const out = maskIntervals([[win(0, 10, KA)], []])
    expect(out[0].size).toBe(0)
  })
})

describe('dropMasked', () => {
  const intervals = maskIntervals([[win(0, 10, KA)], [win(2, 4, KA)]])[0]

  it('drops events inside the window, both ends inclusive', () => {
    const events = [1, 2, 3, 4, 5].map((t) => ev(t, '/a', [t]))
    expect(dropMasked(events, intervals).map((e) => e.t)).toEqual([1, 5])
  })

  it('passes other addresses and other ports through', () => {
    const events = [ev(3, '/b', [1]), ev(3, '/a', [1], 10020), ev(3, '/a', [1])]
    expect(dropMasked(events, intervals)).toEqual([events[0], events[1]])
  })
})

describe('carveKnots', () => {
  it('splits the ramp around a mask, one grid step off both boundaries', () => {
    const [left, right] = carveKnots(ramp, [{ start: 2, end: 4 }])
    expect(left[0].t).toBe(0)
    expect(left[left.length - 1].t).toBe(round6(2 - 1e-6))
    expect(right[0].t).toBe(round6(4 + 1e-6))
    expect(right[right.length - 1].t).toBe(10)
    // The pieces trace the original: 0–2 and 4–10 play the curve unchanged.
    for (const t of [0, 0.5, 1, 1.999999]) {
      expect(evalCurve(left, t)).toBeCloseTo(evalCurve(ramp, t), 6)
    }
    for (const t of [4.000001, 6, 10]) {
      expect(evalCurve(right, t)).toBeCloseTo(evalCurve(ramp, t), 6)
    }
  })

  it('keeps the whole curve when no mask overlaps it', () => {
    expect(carveKnots(ramp, [])).toEqual([ramp])
    expect(carveKnots(ramp, [{ start: 20, end: 30 }])).toEqual([ramp])
  })

  it('drops a fully swallowed curve', () => {
    const short: CurveKnot[] = [
      { t: 2, v: 0.2 },
      { t: 3, v: 0.8 }
    ]
    expect(carveKnots(short, [{ start: 2, end: 4 }])).toEqual([])
  })

  it('carves several masks and drops the degenerate pieces', () => {
    const pieces = carveKnots(ramp, [
      { start: 0, end: 1 },
      { start: 1.000002, end: 5 },
      { start: 9, end: 12 }
    ])
    // The sliver between the first two masks is one grid step wide and dies.
    expect(pieces).toHaveLength(1)
    expect(pieces[0][0].t).toBe(round6(5 + 1e-6))
    expect(pieces[0][pieces[0].length - 1].t).toBe(round6(9 - 1e-6))
  })
})

describe('resumeEvent', () => {
  const windows = [{ start: 0, end: 10 }]
  const swallowed = curve('/a', [
    { t: 2, v: 0.2 },
    { t: 3, v: 0.8 }
  ])

  it('resumes a fully swallowed curve with its end value, one step past the mask', () => {
    const out = resumeEvent({ events: [], curves: [swallowed], pieces: [], windows }, 4)
    expect(out).toEqual({ t: round6(4 + 1e-6), port: PORT, a: '/a', args: [0.8], types: 'f' })
  })

  it('is skipped when a carved piece covers the resume time', () => {
    const pieces = [{ start: round6(4 + 1e-6), end: 10 }]
    const material = { events: [ev(1, '/a', [0.1])], curves: [], pieces, windows }
    expect(resumeEvent(material, 4)).toBeNull()
  })

  it('is skipped when no clip window of the track contains the mask end', () => {
    const material = {
      events: [ev(1, '/a', [0.1])],
      curves: [],
      pieces: [],
      windows: [{ start: 0, end: 3 }]
    }
    expect(resumeEvent(material, 4)).toBeNull()
  })

  it('is null when the track has no definition at or before the end', () => {
    const material = { events: [ev(5, '/a', [0.1])], curves: [], pieces: [], windows }
    expect(resumeEvent(material, 4)).toBeNull()
  })

  it('takes the last event, ties to the later entry', () => {
    const events = [ev(1, '/a', [0.1]), ev(3, '/a', [0.4]), ev(3, '/a', [0.5])]
    const out = resumeEvent({ events, curves: [], pieces: [], windows }, 4)
    expect(out?.args).toEqual([0.5])
    expect(out?.t).toBe(4.000001)
  })

  it('lets a later event outrank a curve that ended before it', () => {
    const c = curve('/a', [
      { t: 1, v: 0 },
      { t: 2, v: 0.9 }
    ])
    const out = resumeEvent({ events: [ev(3, '/a', [0.4])], curves: [c], pieces: [], windows }, 4)
    expect(out?.args).toEqual([0.4])
  })

  it('ignores its own events shadowed by its own curve span', () => {
    // A point inside a span never plays, so it can never be the resumed value.
    const events = [ev(1, '/a', [0.1]), ev(2.5, '/a', [0.7])]
    const out = resumeEvent({ events, curves: [swallowed], pieces: [], windows }, 4)
    expect(out?.args).toEqual([0.8])
  })

  it('splices a curve value into the latest event template, per arg', () => {
    const c = curve('/xy', [
      { t: 2, v: 0 },
      { t: 3, v: 0.9 }
    ])
    const material = {
      events: [ev(1, '/xy', [0.1, 0.5])],
      curves: [{ ...c, arg: 1, args: [0, 0] }],
      pieces: [],
      windows
    }
    const out = resumeEvent(material, 4)
    expect(out).toEqual({ t: 4.000001, port: PORT, a: '/xy', args: [0.1, 0.9], types: 'ff' })
  })
})

describe('the spec example: curve [0,10] under a take [2,4]', () => {
  it('plays curve, take, curve — and the curve piece resumes by itself', () => {
    const upper = win(0, 10, KA)
    const take = win(2, 4, KA)
    const masks = maskIntervals([[upper], [take]])
    const intervals = masks[0].get(KA)!

    const pieces = carveKnots(ramp, intervals)
    expect(pieces.map((p) => [p[0].t, p[p.length - 1].t])).toEqual([
      [0, 1.999999],
      [4.000001, 10]
    ])

    // The take's own events survive: nothing masks the bottom track.
    const takeEvents = [ev(2, '/a', [0.9]), ev(4, '/a', [0.95])]
    expect(dropMasked(takeEvents, masks[1])).toEqual(takeEvents)

    // No resume event: the right piece covers the boundary itself.
    const material = {
      events: [],
      curves: [curve('/a', ramp)],
      pieces: pieces.map((p) => ({ start: p[0].t, end: p[p.length - 1].t })),
      windows: [{ start: upper.start, end: upper.end }]
    }
    expect(resumeEvent(material, 4)).toBeNull()
  })

  it('drops the upper track events the take covers and resumes after it', () => {
    const masks = maskIntervals([[win(0, 10, KA)], [win(2, 4, KA)]])
    const upperEvents = [ev(1, '/a', [0.1]), ev(2, '/a', [0.2]), ev(3, '/a', [0.3])]
    const kept = dropMasked(upperEvents, masks[0])
    expect(kept.map((e) => e.t)).toEqual([1])

    const resume = resumeEvent(
      { events: upperEvents, curves: [], pieces: [], windows: [{ start: 0, end: 10 }] },
      4
    )
    // The masked track resumes its latest masked value, after the take's last
    // event at t = 4 (merge sorts by t).
    expect(resume).toEqual({ t: 4.000001, port: PORT, a: '/a', args: [0.3], types: 'f' })
  })
})
