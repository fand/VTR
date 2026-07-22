import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, expect, test, vi } from 'vitest'
import type { ProjectFile } from '../shared/types'
import { commitProject, resolveClipPath } from './project'

// Crash injection: writeAtomic opens its tmp file with openSync; failing a
// matching open simulates a crash at that step. Opened tmp paths are recorded
// to check tmp-name uniqueness.
let failOpen: ((path: string) => boolean) | null = null
const openedTmps: string[] = []
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    openSync: (p: unknown, ...rest: unknown[]): number => {
      const path = String(p)
      if (path.includes('.tmp')) openedTmps.push(path)
      if (failOpen?.(path)) throw new Error('injected failure')
      return (real.openSync as (...a: unknown[]) => number)(p, ...rest)
    }
  }
})

afterEach(() => {
  failOpen = null
  openedTmps.length = 0
})

const CLIP = [
  '{"type":"session_start","wall":"2026-01-01T00:00:00Z"}',
  '{"t":0.5,"port":10000,"a":"/x","args":[1]}',
  '{"type":"session_end","t":2}',
  ''
].join('\n')

const EDITS: ProjectFile['edits'] = { 'rec.jsonl': { set: { 0: { args: [9] } } } }

/** Untitled-session layout: a staged recording, Save As into a new bundle. */
function setup(): {
  staging: string
  dir: string
  projectPath: string
  project: ProjectFile
  resolveFrom: (file: string) => string
} {
  const root = mkdtempSync(join(tmpdir(), 'vtr-save-'))
  const staging = join(root, 'staging')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'rec.jsonl'), CLIP)
  writeFileSync(join(staging, 'rec.jsonl.edits.json'), '{"set":{"1":{"args":[5]}}}\n')
  const dir = join(root, 'p.oscproj')
  mkdirSync(dir, { recursive: true })
  const projectPath = join(dir, 'project.json')
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: 'rec.jsonl', offset: 0, trimIn: 0, trimOut: 2 }] }],
    edits: EDITS
  }
  // No open project: clips resolve from the workdir (none here) or staging.
  const resolveFrom = (file: string): string => resolveClipPath(root, staging, file)
  return { staging, dir, projectPath, project, resolveFrom }
}

test('save moves staged clips in, writes sidecars, commits project.json', () => {
  const { staging, dir, projectPath, project, resolveFrom } = setup()
  commitProject(projectPath, project, staging, resolveFrom)
  // Bundle owns the clip + fresh sidecar; project.json has no inline edits.
  expect(readFileSync(join(dir, 'clips', 'rec.jsonl'), 'utf8')).toBe(CLIP)
  expect(JSON.parse(readFileSync(join(dir, 'clips', 'rec.jsonl.edits.json'), 'utf8'))).toEqual(
    EDITS['rec.jsonl']
  )
  const onDisk = JSON.parse(readFileSync(projectPath, 'utf8'))
  expect(onDisk.edits).toBeUndefined()
  expect(onDisk.tracks[0].clips[0].file).toBe('rec.jsonl')
  // Staged sources are gone only after the commit succeeded.
  expect(existsSync(join(staging, 'rec.jsonl'))).toBe(false)
  expect(existsSync(join(staging, 'rec.jsonl.edits.json'))).toBe(false)
})

test('crash writing a sidecar: staged sources and old project.json survive', () => {
  const { staging, projectPath, project, resolveFrom } = setup()
  writeFileSync(projectPath, '{"version":1,"tracks":[]}\n')
  failOpen = (p) => p.includes('.edits.json')
  expect(() => commitProject(projectPath, project, staging, resolveFrom)).toThrow(/injected/)
  expect(existsSync(join(staging, 'rec.jsonl'))).toBe(true)
  expect(existsSync(join(staging, 'rec.jsonl.edits.json'))).toBe(true)
  expect(readFileSync(projectPath, 'utf8')).toBe('{"version":1,"tracks":[]}\n')
})

test('crash writing project.json: staged sources and old state survive', () => {
  const { staging, dir, projectPath, project, resolveFrom } = setup()
  writeFileSync(projectPath, '{"version":1,"tracks":[]}\n')
  // An existing sidecar that this save would drop must survive a failed commit.
  const staleSidecar = join(dir, 'clips', 'stale.jsonl.edits.json')
  mkdirSync(join(dir, 'clips'), { recursive: true })
  writeFileSync(staleSidecar, '{"del":{"0":true}}\n')
  const noEdits: ProjectFile = {
    ...project,
    tracks: [
      {
        clips: [
          ...project.tracks[0].clips,
          { file: 'stale.jsonl', offset: 0, trimIn: 0, trimOut: 1 }
        ]
      }
    ]
  }
  failOpen = (p) => p.includes('project.json')
  expect(() => commitProject(projectPath, noEdits, staging, resolveFrom)).toThrow(/injected/)
  expect(existsSync(join(staging, 'rec.jsonl'))).toBe(true)
  expect(readFileSync(projectPath, 'utf8')).toBe('{"version":1,"tracks":[]}\n')
  expect(existsSync(staleSidecar)).toBe(true)
})

test('sidecar for a clip that exists nowhere creates the clips dir', () => {
  const { staging, dir, projectPath, resolveFrom } = setup()
  const project: ProjectFile = {
    version: 1,
    tracks: [{ clips: [{ file: 'ghost.jsonl', offset: 0, trimIn: 0, trimOut: 1 }] }],
    edits: { 'ghost.jsonl': { set: { 0: { args: [1] } } } }
  }
  commitProject(projectPath, project, staging, resolveFrom)
  expect(existsSync(join(dir, 'clips', 'ghost.jsonl.edits.json'))).toBe(true)
})

test('writeAtomic tmp names are unique, never the fixed .tmp', () => {
  const { staging, projectPath, project, resolveFrom } = setup()
  commitProject(projectPath, project, staging, resolveFrom)
  commitProject(projectPath, project, staging, resolveFrom)
  const projectTmps = openedTmps.filter((p) => p.includes('project.json'))
  expect(projectTmps.length).toBe(2)
  expect(projectTmps[0]).not.toBe(projectTmps[1])
  expect(projectTmps).not.toContain(`${projectPath}.tmp`)
})
