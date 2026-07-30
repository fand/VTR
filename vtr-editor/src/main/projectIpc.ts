import { BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { AppContext } from './appContext'
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

  // Hidden (e2e) skips native dialogs; OSC_EDITOR_DIALOG_PATH stands in for
  // the user's pick (open returns null without it, save falls back to the
  // suggested path).
  ipcMain.handle('project:openDialog', async (e) => {
    if (ctx.hidden) {
      const p = process.env.OSC_EDITOR_DIALOG_PATH ?? null
      return p ? ctx.grantProjectPath(p) : null
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    // openDirectory: a .oscproj is a plain dir wherever LSTypeIsPackage
    // doesn't apply (dev runs, non-mac).
    const res = await dialog.showOpenDialog(win!, {
      defaultPath: ctx.projectDir ?? ctx.workdir,
      filters: [{ name: 'Project', extensions: ['oscproj', 'json'] }],
      properties: ['openFile', 'openDirectory']
    })
    return res.canceled || res.filePaths.length === 0
      ? null
      : ctx.grantProjectPath(res.filePaths[0])
  })
  ipcMain.handle('project:saveDialog', async (e, defaultPath?: string) => {
    const fallback = defaultPath ?? join(ctx.projectDir ?? ctx.workdir, 'Untitled.oscproj')
    if (ctx.hidden) {
      // Empty OSC_EDITOR_DIALOG_PATH stands in for a cancelled dialog.
      const p = process.env.OSC_EDITOR_DIALOG_PATH
      return p === '' ? null : ctx.grantProjectPath(p ?? fallback)
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: fallback,
      filters: [{ name: 'Project', extensions: ['oscproj'] }]
    })
    return res.canceled || !res.filePath ? null : ctx.grantProjectPath(res.filePath)
  })

  // Ask where to save; null = user cancelled. Hidden (e2e) skips the native
  // dialog — it would hang the test — and writes the default session.jsonl.
  ipcMain.handle('session:export', async (e, project: ProjectFile) => {
    // Default next to the project: a bundle's parent dir, not inside it.
    const exportDir =
      ctx.projectDir == null
        ? ctx.workdir
        : ctx.projectDir.endsWith('.oscproj')
          ? dirname(ctx.projectDir)
          : ctx.projectDir
    let outPath = join(exportDir, SESSION_FILE)
    if (!ctx.hidden) {
      const win = BrowserWindow.fromWebContents(e.sender)
      const res = await dialog.showSaveDialog(win!, {
        defaultPath: outPath,
        filters: [{ name: 'JSONL', extensions: ['jsonl'] }]
      })
      if (res.canceled || !res.filePath) return null
      outPath = res.filePath
    }
    return exportSession(ctx.resolveClip, project, outPath)
  })
}
