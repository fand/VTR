import { ipcMain, shell } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { clipSummary, readClip } from './clips'
import { mergeClipsToFile } from './mergeClip'
import { ensureWithin } from './paths'
import type { AppContext } from './appContext'
import type { MergeClipResult, PortConfig, ProjectFile } from '../shared/types'

/** merged-YYYYMMDD-HHMMSS.jsonl, bumped (-2, -3, …) while the name is taken. */
function mergedClipName(dir: string, now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  for (let i = 1; ; i++) {
    const file = `merged-${stamp}${i === 1 ? '' : `-${i}`}.jsonl`
    if (!existsSync(join(dir, file))) return file
  }
}

export function registerTapIpc(ctx: AppContext): void {
  // Record straight into the open project's bundle; staging only when untitled.
  ipcMain.handle('tap:start', () =>
    ctx.requireTap().start(ctx.projectDir ? join(ctx.projectDir, 'clips') : undefined)
  )
  ipcMain.handle('tap:stop', () => ctx.requireTap().stop())
  ipcMain.handle('tap:status', () => ctx.requireTap().status())
  ipcMain.handle('tap:setPorts', (_e, ports: PortConfig) => {
    ctx.requireTap().setPorts(ports)
    ctx.player?.setEcho(ports.echo, ports.echoHost)
  })
  ipcMain.handle('clip:summary', (_e, path: string) =>
    clipSummary(ensureWithin(ctx.clipRoots(), path))
  )
  // Raw events; the renderer applies its own (possibly newer) edit overlay.
  // A stale path (clip collected into a bundle since) re-resolves by name.
  ipcMain.handle('clip:events', (_e, path: string) => {
    try {
      return readClip(ensureWithin(ctx.clipRoots(), path)).events
    } catch {
      return readClip(ctx.resolveClip(basename(path))).events
    }
  })
  // Merge: bake the sub-project into a new clip file. It goes to staging, so
  // an undone merge leaves nothing behind in the bundle; save collects it.
  ipcMain.handle('clip:merge', (_e, project: ProjectFile): MergeClipResult => {
    mkdirSync(ctx.stagingDir, { recursive: true })
    const file = mergedClipName(ctx.stagingDir, new Date())
    const path = join(ctx.stagingDir, file)
    const { offset, length, curves } = mergeClipsToFile(ctx.resolveClip, project, path)
    return { file, path, summary: clipSummary(path), offset, length, curves }
  })
  ipcMain.handle('clip:reveal', (_e, file: string) => {
    const path = ctx.resolveClip(basename(file))
    if (!existsSync(path)) throw new Error(`clip file not found: ${basename(file)}`)
    shell.showItemInFolder(path)
  })
}
