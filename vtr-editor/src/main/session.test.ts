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
