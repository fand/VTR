import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import type { ProjectFile } from '../shared/types'
import { mergeProject } from './merge'

test('unreadable clip contributes no events but keeps its duration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-mtr-merge-'))
  writeFileSync(join(dir, 'b.jsonl'), '{"t":0.5,"port":10000,"a":"/x","args":[1]}\n')
  const project: ProjectFile = {
    version: 1,
    tracks: [
      {
        clips: [
          { file: 'gone.jsonl', offset: 0, trimIn: 0, trimOut: 3 },
          { file: 'b.jsonl', offset: 5, trimIn: 0, trimOut: 1 }
        ]
      }
    ]
  }
  const { events, duration } = mergeProject((f) => join(dir, f), project)
  expect(events.map((e) => e.t)).toEqual([5.5])
  expect(duration).toBe(6)
})
