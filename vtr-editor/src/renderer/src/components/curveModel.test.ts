import { describe, expect, it } from 'vitest'
import { maskIntervals, maskKey } from '../../../shared/trackMask'
import type { Interval } from '../../../shared/trackMask'
import type { ClipCurve, ClipEdits, OscEvent } from '../../../shared/types'
import type { ClipInst } from '../timeline/model'
import { buildProperties, type MaskCtx } from './curveModel'

const PORT = 9000
const A = '/f'

function clip(id: number, offset: number, len: number): ClipInst {
  return {
    id,
    file: `c${id}.jsonl`,
    path: `/tmp/c${id}.jsonl`,
    offset,
    trimIn: 0,
    trimOut: len,
    summary: {
      path: `/tmp/c${id}.jsonl`,
      name: `c${id}.jsonl`,
      wall: null,
      duration: len,
      events: 0,
      tlOffset: null,
      dropped: 0,
      writeErrors: 0,
      writeError: null
    }
  }
}

const ev = (t: number, v: number, a = A): OscEvent => ({ t, port: PORT, a, args: [v] })

const ramp: ClipCurve = {
  port: PORT,
  a: A,
  arg: 0,
  args: [0],
  knots: [
    { t: 0, v: 0 },
    { t: 10, v: 1 }
  ]
}

/** The shown clip on the upper track, masked over [start, end] for `key`.
 *  `windows` are the upper track's own clip windows (the resume gate). */
function ctx(
  start: number,
  end: number,
  key = maskKey(PORT, A),
  windows: Interval[] = [{ start: 0, end: 10 }]
): MaskCtx {
  return {
    masks: maskIntervals([[], [{ start, end, keys: new Set([key]) }]]),
    windows: [windows, []],
    trackOf: new Map([[1, 0]])
  }
}

describe('buildProperties masking', () => {
  const points = [ev(1, 0.1), ev(3, 0.3), ev(5, 0.5)]

  it('leaves everything live without a mask', () => {
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: points }], {})
    expect(p.points.map((pt) => pt.masked)).toEqual([false, false, false])
    expect(p.els).toHaveLength(3)
  })

  it('marks masked points and drops them from the merged path', () => {
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: points }], {}, ctx(2, 4))
    expect(p.points.map((pt) => pt.masked)).toEqual([false, true, false])
    // Still drawn and selectable; only the played path loses it (4.000001 is
    // the resume).
    expect(p.els.map((el) => ('knots' in el ? null : el.t))).toEqual([1, 4.000001, 5])
  })

  it('scopes the mask to its own key', () => {
    const other = maskKey(PORT, '/other')
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: points }], {}, ctx(2, 4, other))
    expect(p.points.every((pt) => !pt.masked)).toBe(true)
  })

  it('carves a masked curve into live pieces, keeping the whole knot list', () => {
    const edits: Record<string, ClipEdits> = { 'c1.jsonl': { curves: [ramp] } }
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: [] }], edits, ctx(2, 4))
    expect(p.curves[0].knots.map((k) => k.t)).toEqual([0, 10])
    expect(p.curves[0].maskedRanges).toEqual([{ start: 2, end: 4 }])
    // One el per live piece, each a grid step off the mask boundary.
    const spans = p.els.map((el) =>
      'knots' in el ? [el.knots[0].t, el.knots[el.knots.length - 1].t] : el.t
    )
    expect(spans).toEqual([
      [0, 1.999999],
      [4.000001, 10]
    ])
  })

  it('drops a fully masked curve from the merged path, leaving its resume', () => {
    const edits: Record<string, ClipEdits> = { 'c1.jsonl': { curves: [ramp] } }
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: points }], edits, ctx(0, 10))
    expect(p.curves).toHaveLength(1)
    expect(p.els).toEqual([{ t: 10.000001, v: 1 }])
  })

  it('clips a mask window to the curve it draws over', () => {
    // The clip sits at 4 on the timeline, so its curve spans 4..14.
    const edits: Record<string, ClipEdits> = { 'c1.jsonl': { curves: [ramp] } }
    const [p] = buildProperties([{ clip: clip(1, 4, 10), events: [] }], edits, ctx(0, 6))
    expect(p.curves[0].maskedRanges).toEqual([{ start: 4, end: 6 }])
  })
})

/** A clip may be trimmed past its recording (trimIn < 0, trimOut > duration):
 *  the extension is just empty, so the player holds the last value there. */
describe('buildProperties extended trims', () => {
  // A 3s recording stretched both ways to fill the timeline window [4, 11].
  const extended: ClipInst = { ...clip(1, 4, 3), trimIn: -2, trimOut: 5 }

  it('places points by the negative trimIn and leaves the extension empty', () => {
    const [p] = buildProperties([{ clip: extended, events: [ev(0, 0.1), ev(3, 0.3)] }], {})
    expect(p.els).toEqual([
      { t: 6, v: 0.1 },
      { t: 9, v: 0.3 }
    ])
  })

  it('clips an overlay curve to the recording, not to the extension', () => {
    const edits: Record<string, ClipEdits> = { 'c1.jsonl': { curves: [ramp] } }
    const [p] = buildProperties([{ clip: extended, events: [] }], edits)
    const knots = p.curves[0].knots
    const last = knots[knots.length - 1]
    // Clip-local [0, 5] of the 0..10 ramp → timeline [6, 11].
    expect([knots[0].t, knots[0].v, knots[0].srcIndex]).toEqual([6, 0, 0])
    expect(last.t).toBeCloseTo(11, 6) // bisection split, exact only to ~1e-14
    expect(last.v).toBeCloseTo(0.5, 6)
    expect(last.srcIndex).toBe(-1) // trimOut split, not a source knot
  })

  it('resumes in the extended span, which the clip window still covers', () => {
    // The mask ends at 10 — past the recording, inside the extension.
    const win = [{ start: 4, end: 11 }]
    const [p] = buildProperties(
      [{ clip: extended, events: [ev(0, 0.1), ev(3, 0.3)] }],
      {},
      ctx(8, 10, maskKey(PORT, A), win)
    )
    expect(p.points.map((pt) => pt.masked)).toEqual([false, true])
    expect(p.els).toEqual([
      { t: 6, v: 0.1 },
      { t: 10.000001, v: 0.3 }
    ])
  })
})

/** The merged path must hold what merge exports (docs/tasks/track-priority):
 *  past a mask, discrete upper data resumes its own value at end + 1e-6. */
describe('buildProperties resume', () => {
  const two = [ev(1, 0.1), ev(3, 0.3)]

  it('resumes the last masked value past the window', () => {
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: two }], {}, ctx(2, 4))
    expect(p.els).toEqual([
      { t: 1, v: 0.1 },
      { t: 4.000001, v: 0.3 }
    ])
    // Path only: no dot, no selection identity.
    expect(p.points).toHaveLength(2)
  })

  it('resumes a swallowed curve at its end value', () => {
    const swallowed: ClipCurve = {
      ...ramp,
      knots: [
        { t: 0, v: 0 },
        { t: 3, v: 0.6 }
      ]
    }
    const edits: Record<string, ClipEdits> = { 'c1.jsonl': { curves: [swallowed] } }
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: [] }], edits, ctx(2, 4))
    const last = p.els[p.els.length - 1]
    expect(last).toEqual({ t: 4.000001, v: 0.6 })
  })

  it('skips the resume when a real point sits on it', () => {
    const withPoint = [...two, ev(4.000001, 0.9)]
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: withPoint }], {}, ctx(2, 4))
    expect(p.els).toEqual([
      { t: 1, v: 0.1 },
      { t: 4.000001, v: 0.9 }
    ])
  })

  it('skips the resume when no clip window of the track covers the mask end', () => {
    // Punch-out past the upper clip's own end (window 0..3, mask 2..4).
    const short = ctx(2, 4, maskKey(PORT, A), [{ start: 0, end: 3 }])
    const [p] = buildProperties([{ clip: clip(1, 0, 3), events: two }], {}, short)
    expect(p.els).toEqual([{ t: 1, v: 0.1 }])
  })

  it('skips the resume when a live curve piece covers it', () => {
    const edits: Record<string, ClipEdits> = { 'c1.jsonl': { curves: [ramp] } }
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: [] }], edits, ctx(2, 4))
    // The right piece starts exactly on the resume time and resumes by itself.
    expect(p.els).toHaveLength(2)
    expect(p.els.every((el) => 'knots' in el)).toBe(true)
  })

  it('skips a resume that lands inside the next mask window', () => {
    // Sub-grid gap between two lower clips: 4 + 1e-6 falls in the second.
    const key = maskKey(PORT, A)
    const mask: MaskCtx = {
      masks: maskIntervals([
        [],
        [
          { start: 2, end: 4, keys: new Set([key]) },
          { start: 4.0000005, end: 6, keys: new Set([key]) }
        ]
      ]),
      windows: [[{ start: 0, end: 10 }], []],
      trackOf: new Map([[1, 0]])
    }
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: [...two, ev(5, 0.5)] }], {}, mask)
    expect(p.els).toEqual([
      { t: 1, v: 0.1 },
      { t: 6.000001, v: 0.5 }
    ])
  })

  it('skips the resume when the track defines nothing before the mask end', () => {
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: [ev(5, 0.5)] }], {}, ctx(2, 4))
    expect(p.els).toEqual([{ t: 5, v: 0.5 }])
  })

  it('leaves an unmasked property alone', () => {
    const B = '/other'
    const mixed = [...two, ev(2, 0.7, B), ev(3, 0.8, B)]
    const props = buildProperties([{ clip: clip(1, 0, 10), events: mixed }], {}, ctx(2, 4))
    const other = props.find((p) => p.label === B)
    expect(other?.els).toEqual([
      { t: 2, v: 0.7 },
      { t: 3, v: 0.8 }
    ])
  })
})
