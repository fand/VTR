import { BrowserWindow, ipcMain } from 'electron'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { AppContext } from './appContext'
import type { Dialogs } from './dialogs'
import { commitProject, loadProject, normalizeProjectPath } from './project'
import { clearRecents, loadRecents } from './recents'
import { SESSION_FILE, exportSession } from './session'
import { transferUndoLog } from './undo'
import type { LoadedProject, ProjectFile } from '../shared/types'

/** Menu concerns stay in index.ts; the handlers call back into them. */
export type ProjectIpcDeps = {
  recordRecent: (path: string) => void
  openRecent: (path: string) => void
  recentLabel: (path: string) => string
  refreshMenu: () => void
}

export function registerProjectIpc(
  ctx: AppContext,
  dialogs: Dialogs,
  deps: ProjectIpcDeps,
  bootProjectPath: string | null
): void {
  // In-window File menu mirrors the app menu's Open Recent.
  ipcMain.handle('recents:list', () =>
    loadRecents(ctx.dataDir).map((p) => ({ path: p, label: deps.recentLabel(p) }))
  )
  // Only paths already in the recents list may be opened: opening grants the
  // path, and a compromised renderer must not mint grants for arbitrary files.
  ipcMain.handle('recents:open', (_e, path: string) => {
    if (!loadRecents(ctx.dataDir).includes(path)) throw new Error(`not a recent project: ${path}`)
    deps.openRecent(path)
  })
  ipcMain.handle('recents:clear', () => {
    clearRecents(ctx.dataDir)
    deps.refreshMenu()
  })

  // Boot load: the CLI-arg project (if any); the default is an empty project.
  // Load/save accept a .oscproj bundle or a flat project.json path; the
  // renderer keeps the path as given (window title, save target).
  const load = (path: string): { path: string; project: LoadedProject } => {
    const projectPath = normalizeProjectPath(path)
    const project = loadProject(projectPath, ctx.stagingDir)
    if (!project) throw new Error(`project not found: ${path}`)
    ctx.projectDir = dirname(projectPath)
    ctx.savedUndoSeq = project.undoSeq ?? 0
    deps.recordRecent(path)
    return { path, project }
  }
  if (bootProjectPath) ctx.grantProjectPath(bootProjectPath)
  ipcMain.handle('project:load', () => (bootProjectPath ? load(bootProjectPath) : null))
  ipcMain.handle('project:loadPath', (_e, path: string) => {
    ctx.requireGranted(path)
    return load(path)
  })
  ipcMain.handle('project:save', (_e, path: string, project: ProjectFile) => {
    const projectPath = ctx.requireGranted(path)
    const dir = dirname(projectPath)
    mkdirSync(dir, { recursive: true })
    // Sources resolve with the outgoing projectDir; adopt the new one only
    // after the transactional commit went through.
    commitProject(projectPath, project, ctx.stagingDir, ctx.resolveClip)
    transferUndoLog(ctx.undoDir(), dir, ctx.projectDir === null)
    ctx.projectDir = dir
    ctx.savedUndoSeq = project.undoSeq ?? 0
    deps.recordRecent(path)
  })

  // Dialog results become grants here, never inside the dialog layer.
  ipcMain.handle('project:openDialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const p = await dialogs.openProject(win!, ctx.projectDir ?? ctx.workdir)
    return p == null ? null : ctx.grantProjectPath(p)
  })
  ipcMain.handle('project:saveDialog', async (e, defaultPath?: string) => {
    const fallback = defaultPath ?? join(ctx.projectDir ?? ctx.workdir, 'Untitled.oscproj')
    const win = BrowserWindow.fromWebContents(e.sender)
    const p = await dialogs.saveProject(win!, fallback)
    return p == null ? null : ctx.grantProjectPath(p)
  })

  // Ask where to save; null = user cancelled.
  ipcMain.handle('session:export', async (e, project: ProjectFile) => {
    // Default next to the project: a bundle's parent dir, not inside it.
    const exportDir =
      ctx.projectDir == null
        ? ctx.workdir
        : ctx.projectDir.endsWith('.oscproj')
          ? dirname(ctx.projectDir)
          : ctx.projectDir
    const win = BrowserWindow.fromWebContents(e.sender)
    const outPath = await dialogs.exportSessionPath(win!, join(exportDir, SESSION_FILE))
    if (outPath == null) return null
    return exportSession(ctx.resolveClip, project, outPath)
  })
}
