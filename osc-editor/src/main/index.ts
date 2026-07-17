import { app, shell, BrowserWindow, Menu, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { clipSummary, readClip } from './clips'
import { mergeProject } from './merge'
import { Preview } from './preview'
import { PROJECT_FILE, loadProject, readProjectPorts, saveProject } from './project'
import { exportSession } from './session'
import { SpawnMode, TapManager } from './tap'
import { appendUndo, loadUndoLog, truncateUndoAfter } from './undo'
import { DEFAULT_PORTS, type PortConfig, type ProjectFile, type UndoEntry } from '../shared/types'

// Working directory: cwd when launched from the CLI (per spec).
const workdir = process.cwd()

// App-owned files (control socket, undo log, staged recordings) live in
// userData, not the cwd. OSC_EDITOR_DATA_DIR redirects it (e2e).
if (process.env.OSC_EDITOR_DATA_DIR) {
  app.setPath('userData', resolve(workdir, process.env.OSC_EDITOR_DATA_DIR))
}
const dataDir = app.getPath('userData')
mkdirSync(dataDir, { recursive: true })

// First CLI arg = project file to open at boot (packaged apps have no script arg).
const cliArg = process.argv[app.isPackaged ? 1 : 2]
const cliProjectPath = cliArg ? resolve(workdir, cliArg) : null

// Dir the current project file lives in; clip files resolve against it.
// Defaults to the workdir until a project is opened or saved elsewhere.
let projectDir = workdir

let tap: TapManager | null = null
let tapError: string | null = null

function findTapBinary(): string {
  if (process.env.OSC_TAP_BIN) {
    if (existsSync(process.env.OSC_TAP_BIN)) return process.env.OSC_TAP_BIN
    throw new Error(`OSC_TAP_BIN not found: ${process.env.OSC_TAP_BIN}`)
  }
  // Pick the most recently built one so a stale release/debug build never wins.
  const candidates = [
    join(app.getAppPath(), '../osc-tap/target/release/osc-tap'),
    join(app.getAppPath(), '../osc-tap/target/debug/osc-tap')
  ].filter(existsSync)
  if (candidates.length === 0) {
    throw new Error('osc-tap binary not found (build osc-tap or set OSC_TAP_BIN)')
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return candidates[0]
}

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
      ...(cliProjectPath ? readProjectPorts(cliProjectPath) : undefined)
    }
    tap = new TapManager(findTapBinary(), dataDir, workdir, mode, ports)
    tap.spawnTap()
  } catch (e) {
    tapError = (e as Error).message
    console.error(tapError)
  }

  ipcMain.handle('tap:start', () => requireTap().start())
  ipcMain.handle('tap:stop', async (_e, clipPath: string) => {
    await requireTap().stop()
    return clipSummary(clipPath)
  })
  ipcMain.handle('tap:status', () => requireTap().status())
  ipcMain.handle('tap:setPorts', (_e, ports: PortConfig) => requireTap().setPorts(ports))
  ipcMain.handle('app:workdir', () => workdir)
  // Raw events; the renderer applies its own (possibly newer) edit overlay.
  ipcMain.handle('clip:events', (_e, path: string) => readClip(path).events)
  // Boot load: the CLI-arg project (if any); the default is an empty project.
  ipcMain.handle('project:load', () => {
    if (!cliProjectPath) return null
    const project = loadProject(cliProjectPath)
    if (!project) throw new Error(`project not found: ${cliProjectPath}`)
    projectDir = dirname(cliProjectPath)
    return { path: cliProjectPath, project }
  })
  ipcMain.handle('project:loadPath', (_e, path: string) => {
    const project = loadProject(path)
    if (!project) throw new Error(`project not found: ${path}`)
    projectDir = dirname(path)
    return { path, project }
  })
  ipcMain.handle('project:save', (_e, path: string, project: ProjectFile) => {
    saveProject(path, project)
    projectDir = dirname(path)
  })
  // Hidden (e2e) skips native dialogs; OSC_EDITOR_DIALOG_PATH stands in for
  // the user's pick (open returns null without it, save falls back to the
  // suggested path).
  ipcMain.handle('project:openDialog', async (e) => {
    if (hidden) return process.env.OSC_EDITOR_DIALOG_PATH ?? null
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win!, {
      defaultPath: projectDir,
      filters: [{ name: 'Project', extensions: ['json'] }],
      properties: ['openFile']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })
  ipcMain.handle('project:saveDialog', async (e, defaultPath?: string) => {
    const fallback = defaultPath ?? join(projectDir, PROJECT_FILE)
    if (hidden) return process.env.OSC_EDITOR_DIALOG_PATH ?? fallback
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: fallback,
      filters: [{ name: 'Project', extensions: ['json'] }]
    })
    return res.canceled || !res.filePath ? null : res.filePath
  })
  ipcMain.handle('undo:load', () => loadUndoLog(dataDir))
  ipcMain.handle('undo:append', (_e, entry: UndoEntry) => appendUndo(dataDir, entry))
  ipcMain.handle('undo:truncateAfter', (_e, seq: number) => truncateUndoAfter(dataDir, seq))
  // Ask where to save; null = user cancelled. Hidden (e2e) skips the native
  // dialog — it would hang the test — and writes the default session.jsonl.
  ipcMain.handle('session:export', async (e, project: ProjectFile) => {
    let outPath = join(workdir, 'session.jsonl')
    if (!hidden) {
      const win = BrowserWindow.fromWebContents(e.sender)
      const res = await dialog.showSaveDialog(win!, {
        defaultPath: outPath,
        filters: [{ name: 'JSONL', extensions: ['jsonl'] }]
      })
      if (res.canceled || !res.filePath) return null
      outPath = res.filePath
    }
    return exportSession(projectDir, project, outPath)
  })

  const preview = new Preview()
  ipcMain.handle('preview:play', (_e, project: ProjectFile, fromSec: number) => {
    const merged = mergeProject(projectDir, project)
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
