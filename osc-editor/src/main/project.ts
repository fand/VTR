import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { editsEmpty } from '../shared/edits'
import type { ClipEdits, LoadedProject, PortConfig, ProjectFile } from '../shared/types'
import { clipSummary } from './clips'

export const PROJECT_FILE = 'project.json'

/** Sidecar path for a clip's edit overlay. */
function editsPath(dir: string, file: string): string {
  return join(dir, `${file}.edits.json`)
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

/** Clip files and edit sidecars resolve relative to the project file's dir. */
export function loadProject(projectPath: string): LoadedProject | null {
  if (!existsSync(projectPath)) return null
  const dir = dirname(projectPath)
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as ProjectFile
  const missing: string[] = []
  const edits: Record<string, ClipEdits> = {}
  const tracks = project.tracks.map((track) => ({
    name: track.name,
    clips: track.clips.flatMap((clip) => {
      const clipPath = join(dir, clip.file)
      try {
        const loaded = { ...clip, path: clipPath, summary: clipSummary(clipPath) }
        const sidecar = editsPath(dir, clip.file)
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

export function saveProject(projectPath: string, project: ProjectFile): void {
  const dir = dirname(projectPath)
  const { edits = {}, ...rest } = project
  // Edits travel inline over IPC but live in per-clip sidecar files on disk.
  for (const [file, clipEdits] of Object.entries(edits)) {
    if (!editsEmpty(clipEdits)) {
      writeAtomic(editsPath(dir, file), JSON.stringify(clipEdits) + '\n')
    }
  }
  // Drop stale sidecars for referenced clips whose edits are gone.
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (editsEmpty(edits[clip.file])) {
        rmSync(editsPath(dir, clip.file), { force: true })
      }
    }
  }
  writeAtomic(projectPath, JSON.stringify(rest, null, 2) + '\n')
}
