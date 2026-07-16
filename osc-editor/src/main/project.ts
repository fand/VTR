import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { editsEmpty } from '../shared/edits'
import type { ClipEdits, LoadedProject, PortConfig, ProjectFile } from '../shared/types'
import { clipSummary } from './clips'

const PROJECT_FILE = 'project.json'

/** Sidecar path for a clip's edit overlay. */
function editsPath(workdir: string, file: string): string {
  return join(workdir, `${file}.edits.json`)
}

function writeAtomic(path: string, content: string): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/** Light read of just the ports, for starting osc-tap before the renderer is up. */
export function readProjectPorts(workdir: string): PortConfig | undefined {
  const path = join(workdir, PROJECT_FILE)
  if (!existsSync(path)) return undefined
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as ProjectFile).ports
  } catch {
    return undefined
  }
}

export function loadProject(workdir: string): LoadedProject | null {
  const path = join(workdir, PROJECT_FILE)
  if (!existsSync(path)) return null
  const project = JSON.parse(readFileSync(path, 'utf8')) as ProjectFile
  const missing: string[] = []
  const edits: Record<string, ClipEdits> = {}
  const tracks = project.tracks.map((track) => ({
    name: track.name,
    clips: track.clips.flatMap((clip) => {
      const clipPath = join(workdir, clip.file)
      try {
        const loaded = { ...clip, path: clipPath, summary: clipSummary(clipPath) }
        const sidecar = editsPath(workdir, clip.file)
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

export function saveProject(workdir: string, project: ProjectFile): void {
  const { edits = {}, ...rest } = project
  // Edits travel inline over IPC but live in per-clip sidecar files on disk.
  for (const [file, clipEdits] of Object.entries(edits)) {
    if (!editsEmpty(clipEdits)) {
      writeAtomic(editsPath(workdir, file), JSON.stringify(clipEdits) + '\n')
    }
  }
  // Drop stale sidecars for referenced clips whose edits are gone.
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (editsEmpty(edits[clip.file])) {
        rmSync(editsPath(workdir, clip.file), { force: true })
      }
    }
  }
  writeAtomic(join(workdir, PROJECT_FILE), JSON.stringify(rest, null, 2) + '\n')
}
