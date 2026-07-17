import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'fs'
import { dirname, join } from 'path'
import { editsEmpty } from '../shared/edits'
import type { ClipEdits, LoadedProject, PortConfig, ProjectFile } from '../shared/types'
import { clipSummary } from './clips'

export const PROJECT_FILE = 'project.json'

/** A project ref is either a project.json path or a .oscproj bundle dir. */
export function normalizeProjectPath(path: string): string {
  return path.endsWith('.oscproj') ? join(path, PROJECT_FILE) : path
}

/**
 * Where a clip file lives: the project bundle's clips/, the project dir
 * itself (legacy flat layout), or the staging dir (recorded, not yet
 * collected into a bundle). Falls back to the first candidate when the
 * file exists nowhere (missing clip).
 */
export function resolveClipPath(projectDir: string, stagingDir: string, file: string): string {
  const candidates = [
    join(projectDir, 'clips', file),
    join(projectDir, file),
    join(stagingDir, file)
  ]
  return candidates.find(existsSync) ?? candidates[0]
}

/** Sidecar path for a clip's edit overlay: next to the clip file. */
function editsPath(clipPath: string): string {
  return `${clipPath}.edits.json`
}

let tmpSeq = 0

function writeAtomic(path: string, content: string): void {
  // Unique tmp name: a fixed suffix would let two instances clobber each
  // other's in-flight write. fsync before rename so a crash never publishes
  // an empty or truncated file.
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** Light read of just the ports, for starting osc-tap before the renderer is up. */
export function readProjectPorts(projectPath: string): PortConfig | undefined {
  if (!existsSync(projectPath)) return undefined
  try {
    return (JSON.parse(readFileSync(projectPath, 'utf8')) as ProjectFile).ports
  } catch {
    return undefined
  }
}

/** Clip files and edit sidecars resolve via resolveClipPath. */
export function loadProject(projectPath: string, stagingDir: string): LoadedProject | null {
  if (!existsSync(projectPath)) return null
  const dir = dirname(projectPath)
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as ProjectFile
  const missing: string[] = []
  const edits: Record<string, ClipEdits> = {}
  const tracks = project.tracks.map((track) => ({
    name: track.name,
    clips: track.clips.flatMap((clip) => {
      const clipPath = resolveClipPath(dir, stagingDir, clip.file)
      // A broken sidecar degrades to "no edits", never to "no clip".
      const sidecar = editsPath(clipPath)
      if (!(clip.file in edits) && existsSync(sidecar)) {
        try {
          edits[clip.file] = JSON.parse(readFileSync(sidecar, 'utf8')) as ClipEdits
        } catch {
          // ignore; the clip itself is fine
        }
      }
      try {
        return [{ ...clip, path: clipPath, summary: clipSummary(clipPath) }]
      } catch {
        missing.push(clip.file)
        return [
          {
            ...clip,
            path: clipPath,
            missing: true,
            summary: {
              path: clipPath,
              name: clip.file,
              wall: null,
              duration: clip.trimOut,
              events: 0,
              tlOffset: null
            }
          }
        ]
      }
    })
  }))
  return {
    ports: project.ports,
    duration: project.duration,
    tracks,
    markers: project.markers,
    edits,
    undoSeq: project.undoSeq,
    missing
  }
}

/**
 * Bring every referenced clip (and its edits sidecar) into <dir>/clips/ so a
 * saved project is self-contained. COPIES only — never deletes — so a crash
 * mid-save leaves the sources intact. Returns the staged sources the project
 * now owns; the caller deletes them after project.json has committed.
 */
export function collectClips(
  dir: string,
  stagingDir: string,
  project: ProjectFile,
  resolveFrom: (file: string) => string
): string[] {
  const staged: string[] = []
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const src = resolveFrom(clip.file)
      const dest = join(dir, 'clips', clip.file)
      if (!existsSync(src) || src === dest || src === join(dir, clip.file)) continue
      mkdirSync(join(dir, 'clips'), { recursive: true })
      copyFileSync(src, dest)
      const fromStaging = src === join(stagingDir, clip.file)
      if (fromStaging) staged.push(src)
      if (existsSync(`${src}.edits.json`)) {
        copyFileSync(`${src}.edits.json`, `${dest}.edits.json`)
        if (fromStaging) staged.push(`${src}.edits.json`)
      }
    }
  }
  return staged
}

export function saveProject(projectPath: string, project: ProjectFile, stagingDir: string): void {
  const dir = dirname(projectPath)
  const { edits = {}, ...rest } = project
  // Additive first: edits travel inline over IPC but live in per-clip
  // sidecar files on disk, next to the clip they belong to.
  for (const [file, clipEdits] of Object.entries(edits)) {
    if (!editsEmpty(clipEdits)) {
      const sidecar = editsPath(resolveClipPath(dir, stagingDir, file))
      // A missing-clip sidecar can resolve into a clips/ dir nobody created.
      mkdirSync(dirname(sidecar), { recursive: true })
      writeAtomic(sidecar, JSON.stringify(clipEdits) + '\n')
    }
  }
  // Commit point: everything project.json references now exists on disk.
  writeAtomic(projectPath, JSON.stringify(rest, null, 2) + '\n')
  // Deletions after commit are safe to lose: a stale sidecar only lingers.
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (editsEmpty(edits[clip.file])) {
        rmSync(editsPath(resolveClipPath(dir, stagingDir, clip.file)), { force: true })
      }
    }
  }
}

/**
 * Transactional save: ① copy staged clips + write sidecars (additive),
 * ② commit project.json, ③ only then delete the staged sources. A crash at
 * any point leaves either the fully-old or fully-new state readable.
 */
export function commitProject(
  projectPath: string,
  project: ProjectFile,
  stagingDir: string,
  resolveFrom: (file: string) => string
): void {
  const dir = dirname(projectPath)
  const staged = collectClips(dir, stagingDir, project, resolveFrom)
  saveProject(projectPath, project, stagingDir)
  for (const src of staged) rmSync(src, { force: true })
}
