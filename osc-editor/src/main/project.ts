import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
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
  const candidates = [join(projectDir, 'clips', file), join(projectDir, file), join(stagingDir, file)]
  return candidates.find(existsSync) ?? candidates[0]
}

/** Sidecar path for a clip's edit overlay: next to the clip file. */
function editsPath(clipPath: string): string {
  return `${clipPath}.edits.json`
}

function writeAtomic(path: string, content: string): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, content)
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
      try {
        const loaded = { ...clip, path: clipPath, summary: clipSummary(clipPath) }
        const sidecar = editsPath(clipPath)
        if (!(clip.file in edits) && existsSync(sidecar)) {
          edits[clip.file] = JSON.parse(readFileSync(sidecar, 'utf8')) as ClipEdits
        }
        return [loaded]
      } catch {
        missing.push(clip.file)
        return []
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

/** Move within a volume, copy+delete across volumes. */
function transfer(src: string, dest: string, deleteSrc: boolean): void {
  if (deleteSrc) {
    try {
      renameSync(src, dest)
      return
    } catch {
      // EXDEV etc; fall through to copy.
    }
  }
  copyFileSync(src, dest)
  if (deleteSrc) rmSync(src, { force: true })
}

/**
 * Bring every referenced clip (and its edits sidecar) into <dir>/clips/ so a
 * saved project is self-contained. Staged recordings are moved (the project
 * now owns them); clips owned by another project dir are copied.
 */
export function collectClips(
  dir: string,
  stagingDir: string,
  project: ProjectFile,
  resolveFrom: (file: string) => string
): void {
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const src = resolveFrom(clip.file)
      const dest = join(dir, 'clips', clip.file)
      if (!existsSync(src) || src === dest || src === join(dir, clip.file)) continue
      mkdirSync(join(dir, 'clips'), { recursive: true })
      const fromStaging = src === join(stagingDir, clip.file)
      transfer(src, dest, fromStaging)
      if (existsSync(`${src}.edits.json`)) {
        transfer(`${src}.edits.json`, `${dest}.edits.json`, fromStaging)
      }
    }
  }
}

export function saveProject(projectPath: string, project: ProjectFile, stagingDir: string): void {
  const dir = dirname(projectPath)
  const { edits = {}, ...rest } = project
  // Edits travel inline over IPC but live in per-clip sidecar files on disk,
  // next to the clip they belong to.
  for (const [file, clipEdits] of Object.entries(edits)) {
    if (!editsEmpty(clipEdits)) {
      writeAtomic(editsPath(resolveClipPath(dir, stagingDir, file)), JSON.stringify(clipEdits) + '\n')
    }
  }
  // Drop stale sidecars for referenced clips whose edits are gone.
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (editsEmpty(edits[clip.file])) {
        rmSync(editsPath(resolveClipPath(dir, stagingDir, clip.file)), { force: true })
      }
    }
  }
  writeAtomic(projectPath, JSON.stringify(rest, null, 2) + '\n')
}
