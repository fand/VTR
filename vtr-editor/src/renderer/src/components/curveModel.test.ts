import { describe, expect, it } from 'vitest'
import { maskIntervals, maskKey } from '../../../shared/trackMask'
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

/** The shown clip on the upper track, masked over [start, end] for `key`. */
function ctx(start: number, end: number, key = maskKey(PORT, A)): MaskCtx {
  return {
    masks: maskIntervals([[], [{ start, end, keys: new Set([key]) }]]),
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
    // Still drawn and selectable; only the played path loses it.
    expect(p.els.map((el) => ('knots' in el ? null : el.t))).toEqual([1, 5])
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

  it('drops a fully masked curve from the merged path', () => {
    const edits: Record<string, ClipEdits> = { 'c1.jsonl': { curves: [ramp] } }
    const [p] = buildProperties([{ clip: clip(1, 0, 10), events: points }], edits, ctx(0, 10))
    expect(p.curves).toHaveLength(1)
    expect(p.els).toEqual([])
  })

  it('clips a mask window to the curve it draws over', () => {
    // The clip sits at 4 on the timeline, so its curve spans 4..14.
    const edits: Record<string, ClipEdits> = { 'c1.jsonl': { curves: [ramp] } }
    const [p] = buildProperties([{ clip: clip(1, 4, 10), events: [] }], edits, ctx(0, 6))
    expect(p.curves[0].maskedRanges).toEqual([{ start: 4, end: 6 }])
  })
})
