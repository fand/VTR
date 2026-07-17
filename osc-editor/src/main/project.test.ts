import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import type { ProjectFile } from '../shared/types'
import { loadProject } from './project'

const CLIP = [
  '{"type":"session_start","wall":"2026-01-01T00:00:00Z"}',
  '{"t":0.5,"port":10000,"a":"/x","args":[1]}',
  '{"type":"session_end","t":2}'
].join('\n')

function makeBundle(): { dir: string; staging: string; projectPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'osc-mtr-proj-'))
  const dir = join(root, 'p.oscproj')
  const staging = join(root, 'staging')
  mkdirSync(join(dir, 'clips'), { recursive: true })
  mkdirSync(staging)
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: 'a.jsonl', offset: 0, trimIn: 0, trimOut: 2 }] }]
  }
  writeFileSync(join(dir, 'clips', 'a.jsonl'), CLIP + '\n')
  const projectPath = join(dir, 'project.json')
  writeFileSync(projectPath, JSON.stringify(project) + '\n')
  return { dir, staging, projectPath }
}

test('corrupt edits sidecar keeps the clip, degrades to no edits', () => {
  const { dir, staging, projectPath } = makeBundle()
  writeFileSync(join(dir, 'clips', 'a.jsonl.edits.json'), '{broken')
  const loaded = loadProject(projectPath, staging)!
  expect(loaded.tracks[0].clips.map((c) => c.file)).toEqual(['a.jsonl'])
  expect(loaded.missing).toEqual([])
  expect(loaded.edits).toEqual({})
})

test('unreadable clip is kept in the track as missing', () => {
  const { dir, staging, projectPath } = makeBundle()
  rmSync(join(dir, 'clips', 'a.jsonl'))
  const loaded = loadProject(projectPath, staging)!
  expect(loaded.missing).toEqual(['a.jsonl'])
  const clip = loaded.tracks[0].clips[0]
  expect(clip.file).toBe('a.jsonl')
  expect(clip.missing).toBe(true)
  expect(clip.trimOut).toBe(2)
  expect(clip.summary.events).toBe(0)
  expect(clip.summary.tlOffset).toBeNull()
})

test('valid sidecar still loads', () => {
  const { dir, staging, projectPath } = makeBundle()
  writeFileSync(join(dir, 'clips', 'a.jsonl.edits.json'), '{"set":{"0":{"args":[9]}}}\n')
  const loaded = loadProject(projectPath, staging)!
  expect(loaded.edits['a.jsonl']).toEqual({ set: { 0: { args: [9] } } })
})
