import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LoadedProject, ProjectFile } from '../shared/types'
import { clipSummary } from './clips'

const PROJECT_FILE = 'project.json'

export function loadProject(workdir: string): LoadedProject | null {
  const path = join(workdir, PROJECT_FILE)
  if (!existsSync(path)) return null
  const project = JSON.parse(readFileSync(path, 'utf8')) as ProjectFile
  const missing: string[] = []
  const tracks = project.tracks.map((track) => ({
    clips: track.clips.flatMap((clip) => {
      const clipPath = join(workdir, clip.file)
      try {
        return [{ ...clip, path: clipPath, summary: clipSummary(clipPath) }]
      } catch {
        missing.push(clip.file)
        return []
      }
    })
  }))
  return { tracks, missing }
}

export function saveProject(workdir: string, project: ProjectFile): void {
  const path = join(workdir, PROJECT_FILE)
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(project, null, 2) + '\n')
  renameSync(tmp, path)
}
