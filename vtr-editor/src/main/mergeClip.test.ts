import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import type { ProjectFile } from '../shared/types'
import { readClip } from './clips'
import { mergeClipsToFile } from './mergeClip'

const PORT = 10000

function dirOf(): string {
  return mkdtempSync(join(tmpdir(), 'vtr-mergeclip-'))
}

/** One clip file of plain events; returns its name for the project. */
function clipOf(
  dir: string,
  name: string,
  events: { t: number; a?: string; v?: number; types?: string; args?: unknown[] }[]
): string {
  const lines = events.map((e) =>
    JSON.stringify({
      t: e.t,
      port: PORT,
      a: e.a ?? '/a',
      types: e.types,
      args: e.args ?? [e.v ?? 0]
    })
  )
  writeFileSync(join(dir, name), lines.map((l) => l + '\n').join(''))
  return name
}

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const events = (path: string): Record<string, unknown>[] => lines(path).filter((l) => !l.type)

test('a gap between clips becomes clip-local time plus an empty span', () => {
  const dir = dirOf()
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          { file: clipOf(dir, 'a.jsonl', [{ t: 0.5, v: 0.1 }]), offset: 2, trimIn: 0, trimOut: 1 },
          { file: clipOf(dir, 'b.jsonl', [{ t: 0.25, v: 0.2 }]), offset: 5, trimIn: 0, trimOut: 1 }
        ]
      }
    ]
  }
  const out = join(dir, 'merged.jsonl')
  const merged = mergeClipsToFile((f) => join(dir, f), project, out)

  // Placed at the earliest head; the box runs to the last clip's tail.
  expect(merged).toMatchObject({ offset: 2, length: 4 })
  expect(merged.curves).toEqual([])
  expect(events(out).map((e) => [e.a, e.t, (e.args as number[])[0]])).toEqual([
    ['/a', 0.5, 0.1],
    ['/a', 3.25, 0.2]
  ])
  // The header/trailer make it a clip like any recording.
  expect(lines(out)[0]).toMatchObject({ type: 'session_start', t: 0 })
  expect(lines(out).at(-1)).toEqual({ type: 'session_end', t: 4 })

  // Round-trips: the editor reads it back as a 4s, 2-event clip with no tl.
  const data = readClip(out)
  expect(data.duration).toBe(4)
  expect(data.events).toHaveLength(2)
  expect(data.tlOffset).toBeNull()
})

test('the lower track wins inside the box and the upper one resumes after it', () => {
  const dir = dirOf()
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'up.jsonl', [
              { t: 1, v: 0.1 },
              { t: 2, v: 0.2 },
              { t: 3, v: 0.3 }
            ]),
            offset: 10,
            trimIn: 0,
            trimOut: 10
          }
        ]
      },
      {
        clips: [
          {
            file: clipOf(dir, 'take.jsonl', [
              { t: 0, v: 0.9 },
              { t: 2, v: 0.95 }
            ]),
            offset: 12,
            trimIn: 0,
            trimOut: 2
          }
        ]
      }
    ]
  }
  const out = join(dir, 'merged.jsonl')
  const merged = mergeClipsToFile((f) => join(dir, f), project, out)

  expect(merged).toMatchObject({ offset: 10, length: 10 })
  // Masked event dropped, the take intact, and one resume event carrying the
  // upper track's masked value — all rebased onto the new clip.
  expect(events(out).map((e) => [e.t, (e.args as number[])[0]])).toEqual([
    [1, 0.1],
    [2, 0.9],
    [4, 0.95],
    [4.000001, 0.3]
  ])
})

test('edits are baked in; curves come back clip-local and never as file lines', () => {
  const dir = dirOf()
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'c.jsonl', [
              { t: 0, a: '/x', v: 1 },
              { t: 0.5, a: '/y', v: 2 }
            ]),
            offset: 5,
            trimIn: 0,
            trimOut: 3
          },
          {
            file: clipOf(dir, 'd.jsonl', [{ t: 0, a: '/z', v: 3 }]),
            offset: 9,
            trimIn: 0,
            trimOut: 1
          }
        ]
      }
    ],
    edits: {
      'c.jsonl': {
        // Moved event, deleted event, and a curve on the clip.
        set: { 0: { t: 1, args: { 0: 0.75 } } },
        del: { 1: true },
        curves: [
          {
            port: PORT,
            a: '/x',
            arg: 0,
            args: [0],
            types: 'f',
            knots: [
              { t: 0, v: 0 },
              { t: 2, v: 1 }
            ]
          }
        ]
      }
    }
  }
  const out = join(dir, 'merged.jsonl')
  const merged = mergeClipsToFile((f) => join(dir, f), project, out)

  // The edits are baked: the moved event lands at its new time with its new
  // value, the deleted one is gone.
  expect(events(out).map((e) => [e.a, e.t, (e.args as number[])[0]])).toEqual([
    ['/x', 1, 0.75],
    ['/z', 4, 3]
  ])
  // Clip files carry no curve lines (readClip would skip them anyway).
  expect(lines(out).some((l) => l.type === 'curve')).toBe(false)
  expect(readClip(out).events).toHaveLength(2)
  // The curve rides back on the result, clip-local: timeline 5..7 → 0..2.
  expect(merged.curves).toHaveLength(1)
  expect(merged.curves[0].knots.map((k) => k.t)).toEqual([0, 2])
  expect(merged.curves[0].a).toBe('/x')
})

test('a muted clip contributes no events but keeps its slot in the span', () => {
  const dir = dirOf()
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'live.jsonl', [{ t: 0.5, v: 0.1 }]),
            offset: 0,
            trimIn: 0,
            trimOut: 1
          },
          {
            file: clipOf(dir, 'quiet.jsonl', [{ t: 0.5, v: 0.9 }]),
            offset: 3,
            trimIn: 0,
            trimOut: 2,
            muted: true
          }
        ]
      }
    ]
  }
  const out = join(dir, 'merged.jsonl')
  const merged = mergeClipsToFile((f) => join(dir, f), project, out)

  expect(merged).toMatchObject({ offset: 0, length: 5 })
  expect(events(out)).toHaveLength(1)
  expect(lines(out).at(-1)).toEqual({ type: 'session_end', t: 5 })
})

test('types survives the bake; absent stays absent', () => {
  const dir = dirOf()
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          {
            file: clipOf(dir, 'e.jsonl', [
              { t: 0.5, a: '/x', types: 'fi', args: [0.5, 2] },
              { t: 1, a: '/y', v: 1 }
            ]),
            offset: 4,
            trimIn: 0,
            trimOut: 2
          },
          { file: clipOf(dir, 'f.jsonl', [{ t: 0, v: 0 }]), offset: 7, trimIn: 0, trimOut: 1 }
        ]
      }
    ]
  }
  const out = join(dir, 'merged.jsonl')
  mergeClipsToFile((f) => join(dir, f), project, out)

  const [x, y] = events(out)
  expect(x).toEqual({ t: 0.5, port: PORT, a: '/x', types: 'fi', args: [0.5, 2] })
  expect('types' in y).toBe(false)
})
