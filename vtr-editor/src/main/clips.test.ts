import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import { readClip } from './clips'

function tmpClip(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-clips-'))
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

test('types field flows through when present, stays absent when not', () => {
  const tagged = '{"t":0.5,"port":10000,"a":"/x","types":"fi","args":[0.5,2]}'
  const path = tmpClip(`${START}\n${tagged}\n${EV2}\n`)
  const data = readClip(path)
  expect(data.events[0].types).toBe('fi')
  expect(data.events[1].types).toBeUndefined()
})

test('garbage line mid-file is skipped', () => {
  const path = tmpClip(`${START}\n${EV1}\nnot json at all\n${EV2}\n`)
  const data = readClip(path)
  expect(data.events.map((e) => e.t)).toEqual([0.5, 1.5])
})

test('summary line yields health counters and is not an event', () => {
  const summary =
    '{"type":"summary","t":2,"events":2,"dropped":3,"write_errors":1,"write_error":"disk full"}'
  const end = '{"type":"session_end","t":2}'
  const path = tmpClip(`${START}\n${EV1}\n${EV2}\n${summary}\n${end}\n`)
  const data = readClip(path)
  expect(data.events.map((e) => e.t)).toEqual([0.5, 1.5])
  expect(data.dropped).toBe(3)
  expect(data.writeErrors).toBe(1)
  expect(data.writeError).toBe('disk full')
})

test('clip without summary reads as clean', () => {
  const path = tmpClip(`${START}\n${EV1}\n`)
  const data = readClip(path)
  expect(data.dropped).toBe(0)
  expect(data.writeErrors).toBe(0)
  expect(data.writeError).toBeNull()
})

test('unknown typed line is skipped, not counted as an event', () => {
  const path = tmpClip(`${START}\n${EV1}\n{"type":"future_thing","x":1}\n${EV2}\n`)
  const data = readClip(path)
  expect(data.events.map((e) => e.t)).toEqual([0.5, 1.5])
})
