import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { clipSummary } from './clips'
import { mergeProject } from './merge'
import { Preview } from './preview'
import { loadProject, readProjectPorts, saveProject } from './project'
import { exportSession } from './session'
import { SpawnMode, TapManager } from './tap'
import { DEFAULT_PORTS, type PortConfig, type ProjectFile } from '../shared/types'

// Working directory: cwd when launched from the CLI (per spec).
const workdir = process.cwd()

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

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.osc-mtr.editor')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    const mode: SpawnMode =
      (process.env.OSC_TAP_SPAWN as SpawnMode) ??
      (app.isPackaged && process.platform === 'darwin' ? 'launchd' : 'child')
    // Start on the project's ports right away — no restart dance at boot.
    const ports = { ...DEFAULT_PORTS, ...readProjectPorts(workdir) }
    tap = new TapManager(findTapBinary(), workdir, mode, ports)
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
  ipcMain.handle('project:load', () => loadProject(workdir))
  ipcMain.handle('project:save', (_e, project: ProjectFile) => saveProject(workdir, project))
  ipcMain.handle('session:export', (_e, project: ProjectFile) => exportSession(workdir, project))

  const preview = new Preview()
  ipcMain.handle('preview:play', (_e, project: ProjectFile, fromSec: number) => {
    const merged = mergeProject(workdir, project)
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
