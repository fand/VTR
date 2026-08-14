import { app, shell, BrowserWindow, Menu } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { basename, dirname, join, resolve } from 'path'
import { AppContext } from './appContext'
import { envDialogs } from './dialogs'
import { nativeDialogs } from './nativeDialogs'
import { normalizeProjectPath, readProjectPorts } from './project'
import { SpawnMode, TapManager } from './tap'
import { PlayerManager } from './player'
import { TransportFollow } from './transportFollow'
import { findBinary } from './binary'
import { addRecent, clearRecents, loadRecents, removeRecent } from './recents'
import { clearUndoLog } from './undo'
import { registerProjectIpc } from './projectIpc'
import { registerTapIpc } from './tapIpc'
import { registerPlayerIpc } from './playerIpc'
import { registerWindowIpc } from './windowIpc'
import { registerUndoIpc } from './undoIpc'
import { normalizePorts, type TapPush } from '../shared/types'

// Working directory: cwd when launched from the CLI (per spec).
const workdir = process.cwd()

// App-owned files (control socket, undo log, staged recordings) live in
// userData, not the cwd. OSC_EDITOR_DATA_DIR redirects it (e2e).
if (process.env.OSC_EDITOR_DATA_DIR) {
  app.setPath('userData', resolve(workdir, process.env.OSC_EDITOR_DATA_DIR))
}
const dataDir = app.getPath('userData')
mkdirSync(dataDir, { recursive: true })

// e2e: never show a window or steal focus.
const hidden = process.env.OSC_EDITOR_HIDDEN === '1'

// Recordings for unsaved projects land here, never in the cwd.
const ctx = new AppContext(workdir, dataDir, join(dataDir, 'recordings'), hidden)

// Every user-facing prompt goes through this seam; hidden (e2e) swaps in
// the OSC_EDITOR_* env stand-ins (a native dialog would hang the test).
const dialogs = hidden ? envDialogs : nativeDialogs

// First CLI arg = project file to open at boot (packaged apps have no script arg).
const cliArg = process.argv[app.isPackaged ? 1 : 2]
const cliProjectPath = cliArg ? resolve(workdir, cliArg) : null

// Finder open (macOS file association): before ready it becomes the boot
// project; while running it loads into the app. Registered before ready or
// the launch event is lost.
let bootProjectPath = cliProjectPath
let openAfterReady: ((path: string) => void) | null = null
app.on('open-file', (e, path) => {
  e.preventDefault()
  const projectPath = resolve(workdir, path)
  if (openAfterReady) openAfterReady(projectPath)
  else bootProjectPath = projectPath
})

// Single instance per userData: two instances would share the undo log, the
// staging dir, and the control socket — and vtr-tap's stale-socket cleanup
// would let the second tap steal the first's control plane. The second
// launch forwards its project arg here and quits.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}
app.on('second-instance', (_e, argv, workingDirectory) => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
  // Chromium splices switches into the forwarded argv; the project path is
  // the first non-flag arg (after the script path in dev).
  const nonFlags = argv.slice(1).filter((a) => !a.startsWith('-'))
  const arg = nonFlags[app.isPackaged ? 0 : 1]
  if (!arg) return
  const projectPath = resolve(workingDirectory || workdir, arg)
  if (openAfterReady) openAfterReady(projectPath)
  else bootProjectPath = projectPath
})

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    // Custom title bar: the renderer header doubles as the drag region;
    // traffic lights stay (inset), the native bar goes away.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
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

  // Closing a dirty window prompts save/discard/cancel.
  mainWindow.on('close', (e) => {
    if (ctx.forceClose || !ctx.dirtyState) return
    e.preventDefault()
    const choice = dialogs.quitChoice(mainWindow)
    if (choice === 'cancel') return
    if (choice === 'discard') {
      ctx.forceClose = true
      mainWindow.close()
      return
    }
    // Save first; the renderer confirms via window:confirmClose once the
    // save succeeds. A cancelled Save As leaves the app open.
    mainWindow.webContents.send('menu:saveAndClose')
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

// Recent projects: recorded on load/save, shown under File > Open Recent.
// Opening one reuses the Finder-open path (dirty prompt + grant).
function recordRecent(path: string): void {
  addRecent(dataDir, path, normalizeProjectPath)
  if (process.platform === 'darwin') app.addRecentDocument(path)
  installMenu()
}

function openRecent(path: string): void {
  if (!existsSync(normalizeProjectPath(path))) {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) dialogs.warnMissingProject(win, path)
    removeRecent(dataDir, path)
    installMenu()
    return
  }
  openAfterReady?.(path)
}

// A flat project.json alone is ambiguous; show its parent dir too.
function recentLabel(path: string): string {
  return basename(path) === 'project.json'
    ? join(basename(dirname(path)), 'project.json')
    : basename(path)
}

/**
 * Custom Edit menu: the default menu's Undo/Redo roles would swallow
 * Cmd+Z before the page ever sees the keydown. Ours forwards to the
 * renderer, which owns the history.
 */
function installMenu(): void {
  const recents = loadRecents(dataDir)
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
          {
            label: 'Open Recent',
            submenu: [
              ...recents.map((p) => ({
                label: recentLabel(p),
                click: (): void => openRecent(p)
              })),
              { type: 'separator' as const },
              {
                label: 'Clear Menu',
                enabled: recents.length > 0,
                click: (): void => {
                  clearRecents(dataDir)
                  installMenu()
                }
              }
            ]
          },
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
  electronApp.setAppUserModelId('com.fand.vtr')
  installMenu()

  // A stale staged log (abandoned untitled session) must not leak into this
  // one. Keep it only when the boot project itself lives in the data dir.
  const bootProjectDir = bootProjectPath ? dirname(normalizeProjectPath(bootProjectPath)) : null
  if (bootProjectDir !== dataDir) clearUndoLog(dataDir)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Start on the project's ports right away — no restart dance at boot.
  const ports = normalizePorts(
    bootProjectPath ? readProjectPorts(normalizeProjectPath(bootProjectPath)) : undefined
  )
  const binEnv = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  }
  try {
    const mode: SpawnMode =
      (process.env.VTR_TAP_SPAWN as SpawnMode) ??
      (app.isPackaged && process.platform === 'darwin' ? 'launchd' : 'child')
    const bin = findBinary('vtr-tap', { ...binEnv, envBin: process.env.VTR_TAP_BIN })
    const tap = new TapManager(bin, dataDir, ctx.stagingDir, mode, ports)
    ctx.tap = tap
    tap.spawnTap()
    // Recording state flows renderer-ward through this one channel: events
    // and baseline/reset snapshots alike (snapshot-apply lives there).
    const pushTap = (msg: TapPush): void => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('tap:event', msg)
    }
    void tap.runEventLoop(
      (event) => pushTap({ type: 'event', event }),
      (status) => pushTap({ type: 'reset', status })
    )
    // Live OSC monitor stream, batched by the loop's poll cadence.
    void tap.runMonitorLoop((lines) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('tap:monitor', lines)
    })
  } catch (e) {
    ctx.tapError = (e as Error).message
    console.error(ctx.tapError)
  }

  let transportFollow: TransportFollow | null = null
  try {
    const bin = findBinary('vtr-player', { ...binEnv, envBin: process.env.VTR_PLAYER_BIN })
    // The tap socket path is fixed under dataDir even when the tap failed
    // to start — the player just retries the connection.
    const player = new PlayerManager(
      bin,
      dataDir,
      ports.echo,
      ports.echoHost,
      join(dataDir, 'vtr-tap.sock')
    )
    ctx.player = player
    player.spawnPlayer()
    // Mirror the player's push transport back into the editor: a seek or
    // play/stop from TD or a controller moves the renderer's playhead.
    transportFollow = new TransportFollow(player, (s) => {
      ctx.lastTransport = { state: s, at: Date.now() }
      BrowserWindow.getAllWindows()[0]?.webContents.send('transport:update', s)
    })
    transportFollow.start()
  } catch (e) {
    ctx.playerError = (e as Error).message
    console.error(ctx.playerError)
  }
  app.on('will-quit', () => {
    transportFollow?.stop()
  })

  registerTapIpc(ctx)
  registerPlayerIpc(ctx)
  registerWindowIpc(ctx)
  registerUndoIpc(ctx)
  registerProjectIpc(
    ctx,
    dialogs,
    { recordRecent, openRecent, recentLabel, refreshMenu: installMenu },
    bootProjectPath
  )

  createWindow()

  // Finder open while the app is running: prompt when dirty, then hand the
  // path to the renderer to load.
  openAfterReady = (path) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (ctx.dirtyState && !dialogs.confirmDiscardForOpen(win)) return
    ctx.grantProjectPath(path)
    win.webContents.send('project:openPath', path)
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  ctx.tap?.shutdown()
  ctx.player?.shutdown()
})

app.on('window-all-closed', () => {
  app.quit()
})
