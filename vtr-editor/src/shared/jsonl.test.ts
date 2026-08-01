import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLine } from './jsonl'

const FIXTURE = join(__dirname, '../../../vtr-player/tests/fixtures/session_lines.jsonl')

describe('parseLine', () => {
  it('classifies every golden fixture line as documented there', () => {
    const kinds = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => parseLine(l).kind)
    expect(kinds).toEqual([
      'session_start',
      'event',
      'event',
      'event',
      'curve',
      'summary',
      'unknown',
      'invalid',
      'session_end'
    ])
  })

  it('treats any object without a type field as an event', () => {
    const p = parseLine('{"whatever":1}')
    expect(p.kind).toBe('event')
  })

  it('rejects non-object JSON (matches the Rust loader, which counts it skipped)', () => {
    expect(parseLine('5').kind).toBe('invalid')
    expect(parseLine('"str"').kind).toBe('invalid')
    expect(parseLine('[1,2]').kind).toBe('invalid')
    expect(parseLine('null').kind).toBe('invalid')
  })
})
