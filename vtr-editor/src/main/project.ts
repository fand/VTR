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
import { basename, dirname, join } from 'path'
import { editsEmpty } from '../shared/edits'
import type { ClipEdits, LoadedProject, PortConfig, ProjectFile } from '../shared/types'
import { clipSummary } from './clips'
import { isSafeClipFile } from './paths'

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
  // Defense in depth: a traversal reference never escapes the roots.
  if (!isSafeClipFile(file)) {
    const base = basename(file)
    file = isSafeClipFile(base) ? base : '_invalid_clip_'
  }
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

/** Light read of just the ports, for starting vtr-tap before the renderer is up. */
export function readProjectPorts(projectPath: string): PortConfig | undefined {
  if (!existsSync(projectPath)) return undefined
  try {
    return (JSON.parse(readFileSync(projectPath, 'utf8')) as ProjectFile).ports
  } catch {
    return undefined
  }
}

/** version check + minimal shape check: fail with a clear message instead of
 *  exploding deep in the renderer on a v2 or hand-mangled file. */
function validateProject(raw: unknown): ProjectFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('project.json is not an object')
  }
  const p = raw as Partial<ProjectFile>
  if (p.version !== 1) {
    throw new Error(`unsupported project version ${JSON.stringify(p.version)} (expected 1)`)
  }
  if (!Array.isArray(p.tracks)) {
    throw new Error('project.json: "tracks" must be an array')
  }
  for (const t of p.tracks) {
    if (typeof t !== 'object' || t === null || !Array.isArray(t.clips)) {
      throw new Error('project.json: each track needs a "clips" array')
    }
    for (const c of t.clips) {
      if (typeof c !== 'object' || c === null || typeof c.file !== 'string') {
        throw new Error('project.json: each clip needs a string "file"')
      }
    }
  }
  return p as ProjectFile
}

/** Clip files and edit sidecars resolve via resolveClipPath. */
export function loadProject(projectPath: string, stagingDir: string): LoadedProject | null {
  if (!existsSync(projectPath)) return null
  const dir = dirname(projectPath)
  const project = validateProject(JSON.parse(readFileSync(projectPath, 'utf8')))
  const missing: string[] = []
  const edits: Record<string, ClipEdits> = {}
  const tracks = project.tracks.map((track) => ({
    name: track.name,
    clips: track.clips.flatMap((clip) => {
      const clipPath = resolveClipPath(dir, stagingDir, clip.file)
      const missingEntry = (): (typeof track.clips)[0] & {
        path: string
        missing: boolean
        summary: ReturnType<typeof clipSummary>
      } => {
        missing.push(clip.file)
        return {
          ...clip,
          path: clipPath,
          missing: true,
          summary: {
            path: clipPath,
            name: clip.file,
            wall: null,
            duration: clip.trimOut,
            events: 0,
            tlOffset: null,
            dropped: 0,
            writeErrors: 0,
            writeError: null
          }
        }
      }
      // A traversal reference is never resolved — kept in the doc as missing.
      if (!isSafeClipFile(clip.file)) return [missingEntry()]
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
        return [missingEntry()]
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
      // A traversal reference never writes outside the bundle.
      if (!isSafeClipFile(clip.file)) continue
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
    if (!isSafeClipFile(file)) continue
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
