import { ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { clipSummary, readClip } from './clips'
import { ensureWithin } from './paths'
import type { AppContext } from './appContext'
import type { PortConfig } from '../shared/types'

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
  ipcMain.handle('clip:reveal', (_e, file: string) => {
    const path = ctx.resolveClip(basename(file))
    if (!existsSync(path)) throw new Error(`clip file not found: ${basename(file)}`)
    shell.showItemInFolder(path)
  })
}
