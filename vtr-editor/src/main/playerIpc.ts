import { ipcMain } from 'electron'
import { mergeProject } from './merge'
import type { AppContext } from './appContext'
import {
  DEFAULT_PORTS,
  type OscEvent,
  type ProjectFile,
  type TransportState
} from '../shared/types'

// Inline-load routes: every port seen in the merged events or curves maps
// to the forward port (the player emits only on routed ports). The old
// direct preview also sent everything to the forward port, whatever port
// the clip was recorded on.
function routesFor(
  merged: { events: OscEvent[]; curves: { port: number }[] },
  forward: number
): Record<string, number> {
  const routes: Record<string, number> = {}
  for (const e of merged.events) routes[e.port] = forward
  for (const c of merged.curves) routes[c.port] = forward
  return routes
}

export function registerPlayerIpc(ctx: AppContext): void {
  const forwardPort = (): number => ctx.tap?.ports.forward ?? DEFAULT_PORTS.forward

  ipcMain.handle('player:status', () => ctx.requirePlayer().status())

  // Preview playback is delegated to vtr-player: inline-load the merged
  // project with routes, then drive the shared push transport. The player's
  // emit loop is the only preview emitter — one resolver serves preview,
  // file replay, and TD scrubs alike. Errors reject to the renderer's
  // banner; there is no editor-side fallback path anymore.
  ipcMain.handle('preview:play', async (_e, project: ProjectFile, fromSec: number) => {
    const merged = mergeProject(ctx.resolveClip, project)
    const duration = Math.max(merged.duration, project.duration ?? 0)
    const p = ctx.requirePlayer()
    await p.loadInline(merged.events, merged.curves, duration, routesFor(merged, forwardPort()))
    await p.seek(fromSec)
    const transport = await p.play()
    return { duration, transport }
  })
  ipcMain.handle('preview:seek', (_e, fromSec: number) => ctx.requirePlayer().seek(fromSec))
  ipcMain.handle('preview:stop', async () => {
    const transport = await ctx.requirePlayer().stopTransport()
    return { position: transport.playhead }
  })

  // Seed for a freshly (re)loaded renderer: the last foreign transport
  // state, extrapolated while playing so the playhead lands where the
  // transport actually is, not where it was at the last gen bump.
  ipcMain.handle('transport:last', (): TransportState | null => {
    if (!ctx.lastTransport) return null
    const { state, at } = ctx.lastTransport
    if (!state.playing) return state
    return { ...state, playhead: state.playhead + (Date.now() - at) / 1000 }
  })

  // Session residency: keep the player holding the current merged project
  // even when idle, so a TD-side scrub resolves against something. Called
  // on project open and (debounced) after edits. Best-effort.
  ipcMain.handle('player:loadInline', (_e, project: ProjectFile) => {
    const merged = mergeProject(ctx.resolveClip, project)
    const duration = Math.max(merged.duration, project.duration ?? 0)
    ctx.player
      ?.loadInline(merged.events, merged.curves, duration, routesFor(merged, forwardPort()))
      .catch((e) => console.log(`residency load failed: ${(e as Error).message}`))
  })
}
