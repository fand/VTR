import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import type { ProjectFile } from '../shared/types'
import { exportSession } from './session'

test('export keeps types when present, omits the key when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-session-'))
  writeFileSync(
    join(dir, 'a.jsonl'),
    '{"t":0.5,"port":10000,"a":"/x","types":"fi","args":[0.5,2]}\n' +
      '{"t":1.0,"port":10000,"a":"/y","args":[1]}\n'
  )
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: 'a.jsonl', offset: 0, trimIn: 0, trimOut: 5 }] }]
  }
  const out = join(dir, 'session.jsonl')
  exportSession((f) => join(dir, f), project, out)
  const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const [x, y] = lines.filter((l) => !l.type)
  expect(x.types).toBe('fi')
  expect(x.args).toEqual([0.5, 2])
  expect('types' in y).toBe(false)
})

test('export writes curve lines between the events and the trailer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-session-'))
  writeFileSync(join(dir, 'b.jsonl'), '{"t":0.5,"port":10000,"a":"/x","args":[0.1]}\n')
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: 'b.jsonl', offset: 0, trimIn: 0, trimOut: 5 }] }],
    edits: {
      'b.jsonl': {
        curves: [
          {
            port: 10000,
            a: '/x',
            arg: 0,
            args: [0],
            types: 'f',
            knots: [
              { t: 1, v: 0, o: [0.5, 0.2] },
              { t: 3, v: 1 }
            ]
          }
        ]
      }
    }
  }
  const out = join(dir, 'session.jsonl')
  exportSession((f) => join(dir, f), project, out)
  const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const curve = lines.find((l) => l.type === 'curve')
  expect(curve).toBeDefined()
  expect(curve.a).toBe('/x')
  expect(curve.arg).toBe(0)
  expect(curve.knots).toEqual([
    { t: 1, v: 0, o: [0.5, 0.2] },
    { t: 3, v: 1 }
  ])
  // Order: events, curves, then the session_end trailer.
  expect(lines.findIndex((l) => l.type === 'curve')).toBeGreaterThan(
    lines.findIndex((l) => !l.type)
  )
  expect(lines[lines.length - 1].type).toBe('session_end')
})
