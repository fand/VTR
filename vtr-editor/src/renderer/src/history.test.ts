import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { ratcheted, type Doc } from './history'
import type { ClipInst, TrackState } from './timeline/model'

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

function doc(duration: number, tracks: TrackState[]): Doc {
  return { tracks, markers: [], duration, edits: {} }
}

describe('ratcheted', () => {
  it('keeps the pre-edit extent when the last clip moves earlier', () => {
    // Clip recorded at 2040s while duration stayed at the 60s default.
    const d = doc(60, [{ id: 1, clips: [clip(2, 2040, 30)] }])
    const next = produce(
      d,
      ratcheted((dr) => {
        dr.tracks[0].clips[0].offset = 1800
      })
    )
    expect(next.duration).toBe(2070)
  })

  it('grows the duration when a clip moves past it', () => {
    const d = doc(60, [{ id: 1, clips: [clip(2, 0, 30)] }])
    const next = produce(
      d,
      ratcheted((dr) => {
        dr.tracks[0].clips[0].offset = 100
      })
    )
    expect(next.duration).toBe(130)
  })

  it('lets a duration edit shrink down to the content end, not below', () => {
    const d = doc(300, [{ id: 1, clips: [clip(2, 100, 30)] }])
    const next = produce(
      d,
      ratcheted((dr) => {
        dr.duration = 10
      })
    )
    expect(next.duration).toBe(130)
  })

  it('leaves an explicit duration above content untouched', () => {
    const d = doc(60, [{ id: 1, clips: [clip(2, 0, 30)] }])
    const next = produce(
      d,
      ratcheted((dr) => {
        dr.duration = 500
      })
    )
    expect(next.duration).toBe(500)
  })
})
