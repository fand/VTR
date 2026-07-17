import { app, shell, BrowserWindow, Menu, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { basename, dirname, join, resolve } from 'path'
import { clipSummary, readClip } from './clips'
import { mergeProject } from './merge'
import { Preview } from './preview'
import {
  collectClips,
  loadProject,
  normalizeProjectPath,
  readProjectPorts,
  resolveClipPath,
  saveProject
} from './project'
import { SESSION_FILE, exportSession } from './session'
import { SpawnMode, TapManager } from './tap'
import { findTapBinary } from './tapBinary'
import { appendUndo, clearUndoLog, loadUndoLog, transferUndoLog, truncateUndoAfter } from './undo'
import {
  DEFAULT_PORTS,
  type LoadedProject,
  type PortConfig,
  type ProjectFile,
  type UndoEntry
} from '../shared/types'

// Working directory: cwd when launched from the CLI (per spec).
const workdir = process.cwd()

// App-owned files (control socket, undo log, staged recordings) live in
// userData, not the cwd. OSC_EDITOR_DATA_DIR redirects it (e2e).
if (process.env.OSC_EDITOR_DATA_DIR) {
  app.setPath('userData', resolve(workdir, process.env.OSC_EDITOR_DATA_DIR))
}
const dataDir = app.getPath('userData')
mkdirSync(dataDir, { recursive: true })

// Recordings for unsaved projects land here, never in the cwd.
const stagingDir = join(dataDir, 'recordings')

// First CLI arg = project file to open at boot (packaged apps have no script arg).
const cliArg = process.argv[app.isPackaged ? 1 : 2]
const cliProjectPath = cliArg ? resolve(workdir, cliArg) : null

// Dir the current project lives in (the .oscproj bundle, or the dir of a
// legacy flat project.json). Null until a project is opened or saved.
let projectDir: string | null = null

// Clip files resolve against the project bundle, then staging.
const resolveClip = (file: string): string =>
  resolveClipPath(projectDir ?? workdir, stagingDir, file)

// The undo log lives in the project bundle; untitled sessions stage it in
// userData and it moves into the bundle on Save As.
const undoDir = (): string => projectDir ?? dataDir

// undoSeq of the last saved/loaded doc; log compaction must keep everything
// past it (boot's redo / crash-recovery tail).
let savedUndoSeq = 0

let tap: TapManager | null = null
let tapError: string | null = null

function requireTap(): TapManager {
  if (!tap) throw new Error(tapError ?? 'osc-tap not running')
  return tap
}

// e2e: never show a window or steal focus.
const hidden = process.env.OSC_EDITOR_HIDDEN === '1'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Keep rAF/timers running when the window is hidden or occluded
      // (timecode/playhead must not freeze; e2e runs fully hidden).
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!hidden) mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// No dock icon, no app activation — the running test never grabs focus.
if (hidden && process.platform === 'darwin') app.setActivationPolicy('accessory')

/**
 * Custom Edit menu: the default menu's Undo/Redo roles would swallow
 * Cmd+Z before the page ever sees the keydown. Ours forwards to the
 * renderer, which owns the history.
 */
function installMenu(): void {
  const send = (channel: string) => (): void => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel)
  }
  // Copy/Paste do the native text-field action here (a no-op without an
  // editable focus) and also notify the renderer, which handles clips.
  const sendWithNative = (channel: string, native: 'copy' | 'paste') => (): void => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents
    if (!wc) return
    wc[native]()
    wc.send(channel)
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
      {
        label: 'File',
        submenu: [
          { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('menu:open') },
          { type: 'separator' },
          { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('menu:save') },
          { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: send('menu:saveAs') }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('menu:undo') },
          { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('menu:redo') },
          { type: 'separator' },
          { role: 'cut' },
          { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: sendWithNative('menu:copy', 'copy') },
          {
            label: 'Paste',
            accelerator: 'CmdOrCtrl+V',
            click: sendWithNative('menu:paste', 'paste')
          },
          { role: 'selectAll' }
        ]
      },
      { role: 'windowMenu' }
    ])
  )
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.osc-mtr.editor')
  installMenu()

  // A stale staged log (abandoned untitled session) must not leak into this
  // one. Keep it only when the boot project itself lives in the data dir.
  const bootProjectDir = cliProjectPath ? dirname(normalizeProjectPath(cliProjectPath)) : null
  if (bootProjectDir !== dataDir) clearUndoLog(dataDir)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    const mode: SpawnMode =
      (process.env.OSC_TAP_SPAWN as SpawnMode) ??
      (app.isPackaged && process.platform === 'darwin' ? 'launchd' : 'child')
    // Start on the project's ports right away — no restart dance at boot.
    const ports = {
      ...DEFAULT_PORTS,
      ...(cliProjectPath ? readProjectPorts(normalizeProjectPath(cliProjectPath)) : undefined)
    }
    const bin = findTapBinary({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      envBin: process.env.OSC_TAP_BIN
    })
    tap = new TapManager(bin, dataDir, stagingDir, mode, ports)
    tap.spawnTap()
  } catch (e) {
    tapError = (e as Error).message
    console.error(tapError)
  }

  // Record straight into the open project's bundle; staging only when untitled.
  ipcMain.handle('tap:start', () =>
    requireTap().start(projectDir ? join(projectDir, 'clips') : undefined)
  )
  ipcMain.handle('tap:stop', async (_e, clipPath: string) => {
    await requireTap().stop()
    return clipSummary(clipPath)
  })
  ipcMain.handle('tap:status', () => requireTap().status())
  ipcMain.handle('tap:setPorts', (_e, ports: PortConfig) => requireTap().setPorts(ports))
  ipcMain.handle('app:workdir', () => workdir)
  // macOS: proxy icon in the title bar carries the full path; the edited
  // state shows as a dot on the close button. No-ops on other platforms.
  ipcMain.handle('window:setFile', (e, path: string | null, dirty: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.setRepresentedFilename(path ?? '')
    win?.setDocumentEdited(dirty)
  })
  // Raw events; the renderer applies its own (possibly newer) edit overlay.
  // A stale path (clip collected into a bundle since) re-resolves by name.
  ipcMain.handle('clip:events', (_e, path: string) => {
    try {
      return readClip(path).events
    } catch {
      return readClip(resolveClip(basename(path))).events
    }
  })
  ipcMain.handle('clip:reveal', (_e, file: string) => {
    const path = resolveClip(basename(file))
    if (!existsSync(path)) throw new Error(`clip file not found: ${basename(file)}`)
    shell.showItemInFolder(path)
  })
  // Boot load: the CLI-arg project (if any); the default is an empty project.
  // Load/save accept a .oscproj bundle or a flat project.json path; the
  // renderer keeps the path as given (window title, save target).
  const load = (path: string): { path: string; project: LoadedProject } => {
    const projectPath = normalizeProjectPath(path)
    const project = loadProject(projectPath, stagingDir)
    if (!project) throw new Error(`project not found: ${path}`)
    projectDir = dirname(projectPath)
    savedUndoSeq = project.undoSeq ?? 0
    return { path, project }
  }
  ipcMain.handle('project:load', () => (cliProjectPath ? load(cliProjectPath) : null))
  ipcMain.handle('project:loadPath', (_e, path: string) => load(path))
  ipcMain.handle('project:save', (_e, path: string, project: ProjectFile) => {
    const projectPath = normalizeProjectPath(path)
    const dir = dirname(projectPath)
    mkdirSync(dir, { recursive: true })
    // Resolve sources with the outgoing projectDir, then adopt the new one.
    collectClips(dir, stagingDir, project, resolveClip)
    transferUndoLog(undoDir(), dir, projectDir === null)
    projectDir = dir
    savedUndoSeq = project.undoSeq ?? 0
    saveProject(projectPath, project, stagingDir)
  })
  // Hidden (e2e) skips native dialogs; OSC_EDITOR_DIALOG_PATH stands in for
  // the user's pick (open returns null without it, save falls back to the
  // suggested path).
  ipcMain.handle('project:openDialog', async (e) => {
    if (hidden) return process.env.OSC_EDITOR_DIALOG_PATH ?? null
    const win = BrowserWindow.fromWebContents(e.sender)
    // openDirectory: a .oscproj is a plain dir wherever LSTypeIsPackage
    // doesn't apply (dev runs, non-mac).
    const res = await dialog.showOpenDialog(win!, {
      defaultPath: projectDir ?? workdir,
      filters: [{ name: 'Project', extensions: ['oscproj', 'json'] }],
      properties: ['openFile', 'openDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })
  ipcMain.handle('project:saveDialog', async (e, defaultPath?: string) => {
    const fallback = defaultPath ?? join(projectDir ?? workdir, 'Untitled.oscproj')
    if (hidden) return process.env.OSC_EDITOR_DIALOG_PATH ?? fallback
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: fallback,
      filters: [{ name: 'Project', extensions: ['oscproj'] }]
    })
    return res.canceled || !res.filePath ? null : res.filePath
  })
  ipcMain.handle('undo:load', () => loadUndoLog(undoDir()))
  ipcMain.handle('undo:append', (_e, entry: UndoEntry) => appendUndo(undoDir(), entry, savedUndoSeq))
  ipcMain.handle('undo:truncateAfter', (_e, seq: number) => truncateUndoAfter(undoDir(), seq))
  // Ask where to save; null = user cancelled. Hidden (e2e) skips the native
  // dialog — it would hang the test — and writes the default session.jsonl.
  ipcMain.handle('session:export', async (e, project: ProjectFile) => {
    // Default next to the project: a bundle's parent dir, not inside it.
    const exportDir =
      projectDir == null ? workdir : projectDir.endsWith('.oscproj') ? dirname(projectDir) : projectDir
    let outPath = join(exportDir, SESSION_FILE)
    if (!hidden) {
      const win = BrowserWindow.fromWebContents(e.sender)
      const res = await dialog.showSaveDialog(win!, {
        defaultPath: outPath,
        filters: [{ name: 'JSONL', extensions: ['jsonl'] }]
      })
      if (res.canceled || !res.filePath) return null
      outPath = res.filePath
    }
    return exportSession(resolveClip, project, outPath)
  })

  const preview = new Preview()
  ipcMain.handle('preview:play', (_e, project: ProjectFile, fromSec: number) => {
    const merged = mergeProject(resolveClip, project)
    preview.play(merged.events, fromSec, tap?.ports.forward ?? DEFAULT_PORTS.forward)
    return { duration: Math.max(merged.duration, project.duration ?? 0) }
  })
  ipcMain.handle('preview:stop', () => ({ position: preview.stop() }))

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  tap?.shutdown()
})

app.on('window-all-closed', () => {
  app.quit()
})
