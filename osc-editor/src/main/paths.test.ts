import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'vitest'
import type { ProjectFile } from '../shared/types'
import { ensureWithin, isSafeClipFile, isWithin } from './paths'
import { collectClips, loadProject, resolveClipPath } from './project'

test('isWithin: inside, the root itself, and prefix tricks', () => {
  expect(isWithin('/a/b', '/a/b/c.txt')).toBe(true)
  expect(isWithin('/a/b', '/a/b')).toBe(true)
  expect(isWithin('/a/b', '/a/bb/c.txt')).toBe(false)
  expect(isWithin('/a/b', '/a/b/../c')).toBe(false)
  expect(isWithin('/a/b', '/etc/passwd')).toBe(false)
})

test('ensureWithin: first matching root wins, otherwise throws', () => {
  expect(ensureWithin(['/a', '/b'], '/b/x')).toBe('/b/x')
  expect(ensureWithin([null, '/b'], '/b/x')).toBe('/b/x')
  expect(() => ensureWithin(['/a'], '/a/../etc/passwd')).toThrow(/outside/)
  expect(() => ensureWithin([null], '/anything')).toThrow(/outside/)
})

test('isSafeClipFile rejects traversal and separators', () => {
  expect(isSafeClipFile('clip-1.jsonl')).toBe(true)
  expect(isSafeClipFile('../clip.jsonl')).toBe(false)
  expect(isSafeClipFile('a/b.jsonl')).toBe(false)
  expect(isSafeClipFile('a\\b.jsonl')).toBe(false)
  expect(isSafeClipFile('..')).toBe(false)
  expect(isSafeClipFile('')).toBe(false)
})

test('resolveClipPath never escapes its roots', () => {
  const p = resolveClipPath('/proj', '/staging', '../../etc/passwd')
  expect(isWithin('/proj', p)).toBe(true)
})

test('resolveClipPath precedence: clips/ > flat > staging > first candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'vtr-paths-'))
  const proj = join(root, 'p.oscproj')
  const staging = join(root, 'staging')
  mkdirSync(join(proj, 'clips'), { recursive: true })
  mkdirSync(staging, { recursive: true })
  const put = (dir: string): void => writeFileSync(join(dir, 'c.jsonl'), 'x\n')

  // Missing everywhere: falls back to the bundle clips/ candidate.
  expect(resolveClipPath(proj, staging, 'c.jsonl')).toBe(join(proj, 'clips', 'c.jsonl'))
  put(staging)
  expect(resolveClipPath(proj, staging, 'c.jsonl')).toBe(join(staging, 'c.jsonl'))
  put(proj) // legacy flat layout beats staging
  expect(resolveClipPath(proj, staging, 'c.jsonl')).toBe(join(proj, 'c.jsonl'))
  put(join(proj, 'clips')) // bundle clips/ beats both
  expect(resolveClipPath(proj, staging, 'c.jsonl')).toBe(join(proj, 'clips', 'c.jsonl'))
})

test('loadProject marks a traversal clip.file missing without touching disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'vtr-paths-'))
  const dir = join(root, 'p.oscproj')
  mkdirSync(dir, { recursive: true })
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: '../../outside.jsonl', offset: 0, trimIn: 0, trimOut: 1 }] }]
  }
  // A file that WOULD resolve if traversal were honored.
  writeFileSync(join(root, 'outside.jsonl'), '{"t":0,"port":1,"a":"/x","args":[1]}\n')
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
  const loaded = loadProject(join(dir, 'project.json'), join(root, 'staging'))!
  expect(loaded.missing).toEqual(['../../outside.jsonl'])
  expect(loaded.tracks[0].clips[0].missing).toBe(true)
})

test('collectClips skips traversal clip.file', () => {
  const root = mkdtempSync(join(tmpdir(), 'vtr-paths-'))
  const staging = join(root, 'staging')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(root, 'victim.jsonl'), 'data\n')
  const dir = join(root, 'p.oscproj')
  mkdirSync(dir, { recursive: true })
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: '../victim.jsonl', offset: 0, trimIn: 0, trimOut: 1 }] }]
  }
  const staged = collectClips(dir, staging, project, () => join(root, 'victim.jsonl'))
  expect(staged).toEqual([])
  expect(existsSync(join(dir, 'victim.jsonl'))).toBe(false)
  expect(existsSync(join(dir, 'clips'))).toBe(false)
})
