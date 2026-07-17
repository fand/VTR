import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import { readClip } from './clips'

function tmpClip(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'osc-mtr-clips-'))
  const path = join(dir, 'clip.jsonl')
  writeFileSync(path, content)
  return path
}

const START = '{"type":"session_start","wall":"2026-01-01T00:00:00Z"}'
const EV1 = '{"t":0.5,"port":10000,"a":"/x","args":[1]}'
const EV2 = '{"t":1.5,"port":10000,"a":"/x","args":[2]}'

test('torn last line is skipped, intact events survive', () => {
  const path = tmpClip(`${START}\n${EV1}\n${EV2}\n{"t":2.0,"por`)
  const data = readClip(path)
  expect(data.events.map((e) => e.t)).toEqual([0.5, 1.5])
  expect(data.wall).toBe('2026-01-01T00:00:00Z')
  expect(data.duration).toBe(1.5)
})

test('garbage line mid-file is skipped', () => {
  const path = tmpClip(`${START}\n${EV1}\nnot json at all\n${EV2}\n`)
  const data = readClip(path)
  expect(data.events.map((e) => e.t)).toEqual([0.5, 1.5])
})
