import { app, shell, BrowserWindow, Menu, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { basename, dirname, join, resolve } from 'path'
import { clipSummary, readClip } from './clips'
import { mergeProject } from './merge'
import {
  commitProject,
  loadProject,
  normalizeProjectPath,
  readProjectPorts,
  resolveClipPath
} from './project'
import { SESSION_FILE, exportSession } from './session'
import { ensureWithin } from './paths'
import { SpawnMode, TapManager } from './tap'
import { PlayerManager } from './player'
import { TransportFollow } from './transportFollow'
import { findBinary } from './binary'
import { addRecent, clearRecents, loadRecents, removeRecent } from './recents'
import { appendUndo, clearUndoLog, loadUndoLog, transferUndoLog, truncateUndoAfter } from './undo'
import {
  DEFAULT_PORTS,
  normalizePorts,
  type LoadedProject,
  type OscEvent,
  type PortConfig,
  type ProjectFile,
  type TapPush,
  type TransportState,
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
// staging dir, and the control socket — and osc-tap's stale-socket cleanup
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

// Dir the current project lives in (the .oscproj bundle, or the dir of a
// legacy flat project.json). Null until a project is opened or saved.
let projectDir: string | null = null

// Clip files resolve against the project bundle, then staging.
const resolveClip = (file: string): string =>
  resolveClipPath(projectDir ?? workdir, stagingDir, file)

// Roots a renderer-supplied clip path may point into.
const clipRoots = (): (string | null)[] => [projectDir ?? workdir, stagingDir]

// Project paths the user explicitly granted (CLI arg or a native dialog
// result). project:save and project:loadPath refuse anything else, so a
// compromised renderer can't write or read arbitrary locations.
const grantedPaths = new Set<string>()
const grantProjectPath = (p: string): string => {
  grantedPaths.add(normalizeProjectPath(p))
  return p
}
const requireGranted = (p: string): string => {
  const projectPath = normalizeProjectPath(p)
  if (!grantedPaths.has(projectPath)) {
    throw new Error(`project path not granted by a dialog: ${p}`)
  }
  return projectPath
}

// Inline-load routes: every port seen in the merged events maps to the
// forward port (the player emits only on routed ports). The old direct
// preview also sent everything to the forward port, whatever port the
// clip was recorded on.
function routesFor(events: OscEvent[], forward: number): Record<string, number> {
  const routes: Record<string, number> = {}
  for (const e of events) routes[e.port] = forward
  return routes
}

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

let player: PlayerManager | null = null
let playerError: string | null = null
let transportFollow: TransportFollow | null = null
// Last foreign transport state, kept so a renderer that loads (or reloads)
// after a change can seed its playhead instead of assuming 0.
let lastTransport: { state: TransportState; at: number } | null = null

function requirePlayer(): PlayerManager {
  if (!player) throw new Error(playerError ?? 'vtr-player not running')
  return player
}

// e2e: never show a window or steal focus.
const hidden = process.env.OSC_EDITOR_HIDDEN === '1'

// Unsaved-changes guard: the renderer reports dirty through window:setFile;
// closing a dirty window prompts save/discard/cancel. Hidden (e2e) takes the
// choice from OSC_EDITOR_QUIT_CHOICE instead of a native dialog; the default
// is discard, matching the documented no-autosave quit.
let dirtyState = false
let forceClose = false

function quitChoice(win: BrowserWindow): number {
  if (hidden) {
    const byName: Record<string, number> = { save: 0, discard: 1, cancel: 2 }
    return byName[process.env.OSC_EDITOR_QUIT_CHOICE ?? 'discard'] ?? 1
  }
  return dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'You have unsaved changes.',
    detail: 'Your changes will be lost if you close without saving.'
  })
}

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

  mainWindow.on('close', (e) => {
    if (forceClose || !dirtyState) return
    e.preventDefault()
    const choice = quitChoice(mainWindow)
    if (choice === 2) return
    if (choice === 1) {
      forceClose = true
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
    if (win && !hidden) {
      dialog.showMessageBoxSync(win, {
        type: 'warning',
        message: 'Project not found.',
        detail: path
      })
    }
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
      (process.env.OSC_TAP_SPAWN as SpawnMode) ??
      (app.isPackaged && process.platform === 'darwin' ? 'launchd' : 'child')
    const bin = findBinary('osc-tap', { ...binEnv, envBin: process.env.OSC_TAP_BIN })
    tap = new TapManager(bin, dataDir, stagingDir, mode, ports)
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
  } catch (e) {
    tapError = (e as Error).message
    console.error(tapError)
  }

  try {
    const bin = findBinary('vtr-player', { ...binEnv, envBin: process.env.VTR_PLAYER_BIN })
    // The tap socket path is fixed under dataDir even when the tap failed
    // to start — the player just retries the connection.
    player = new PlayerManager(bin, dataDir, ports.echo, join(dataDir, 'osc-tap.sock'))
    player.spawnPlayer()
    // Mirror the player's push transport back into the editor: a seek or
    // play/stop from TD or a controller moves the renderer's playhead.
    transportFollow = new TransportFollow(player, (s) => {
      lastTransport = { state: s, at: Date.now() }
      BrowserWindow.getAllWindows()[0]?.webContents.send('transport:update', s)
    })
    transportFollow.start()
  } catch (e) {
    playerError = (e as Error).message
    console.error(playerError)
  }

  // Record straight into the open project's bundle; staging only when untitled.
  ipcMain.handle('tap:start', () =>
    requireTap().start(projectDir ? join(projectDir, 'clips') : undefined)
  )
  ipcMain.handle('tap:stop', () => requireTap().stop())
  ipcMain.handle('tap:status', () => requireTap().status())
  ipcMain.handle('clip:summary', (_e, path: string) => clipSummary(ensureWithin(clipRoots(), path)))
  ipcMain.handle('tap:setPorts', (_e, ports: PortConfig) => {
    requireTap().setPorts(ports)
    player?.setEchoPort(ports.echo)
  })
  ipcMain.handle('player:status', () => requirePlayer().status())
  ipcMain.handle('app:workdir', () => workdir)
  // In-window File menu mirrors the app menu's Open Recent.
  ipcMain.handle('recents:list', () =>
    loadRecents(dataDir).map((p) => ({ path: p, label: recentLabel(p) }))
  )
  // Only paths already in the recents list may be opened: opening grants the
  // path, and a compromised renderer must not mint grants for arbitrary files.
  ipcMain.handle('recents:open', (_e, path: string) => {
    if (!loadRecents(dataDir).includes(path)) throw new Error(`not a recent project: ${path}`)
    openRecent(path)
  })
  ipcMain.handle('recents:clear', () => {
    clearRecents(dataDir)
    installMenu()
  })
  // macOS: proxy icon in the title bar carries the full path; the edited
  // state shows as a dot on the close button. No-ops on other platforms.
  ipcMain.handle('window:setFile', (e, path: string | null, dirty: boolean) => {
    dirtyState = dirty
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.setRepresentedFilename(path ?? '')
    win?.setDocumentEdited(dirty)
  })
  // The renderer saved after a quit prompt chose Save; finish the close.
  ipcMain.handle('window:confirmClose', (e) => {
    forceClose = true
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  // Raw events; the renderer applies its own (possibly newer) edit overlay.
  // A stale path (clip collected into a bundle since) re-resolves by name.
  ipcMain.handle('clip:events', (_e, path: string) => {
    try {
      return readClip(ensureWithin(clipRoots(), path)).events
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
    recordRecent(path)
    return { path, project }
  }
  if (bootProjectPath) grantProjectPath(bootProjectPath)
  ipcMain.handle('project:load', () => (bootProjectPath ? load(bootProjectPath) : null))
  ipcMain.handle('project:loadPath', (_e, path: string) => {
    requireGranted(path)
    return load(path)
  })
  ipcMain.handle('project:save', (_e, path: string, project: ProjectFile) => {
    const projectPath = requireGranted(path)
    const dir = dirname(projectPath)
    mkdirSync(dir, { recursive: true })
    // Sources resolve with the outgoing projectDir; adopt the new one only
    // after the transactional commit went through.
    commitProject(projectPath, project, stagingDir, resolveClip)
    transferUndoLog(undoDir(), dir, projectDir === null)
    projectDir = dir
    savedUndoSeq = project.undoSeq ?? 0
    recordRecent(path)
  })
  // Hidden (e2e) skips native dialogs; OSC_EDITOR_DIALOG_PATH stands in for
  // the user's pick (open returns null without it, save falls back to the
  // suggested path).
  ipcMain.handle('project:openDialog', async (e) => {
    if (hidden) {
      const p = process.env.OSC_EDITOR_DIALOG_PATH ?? null
      return p ? grantProjectPath(p) : null
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    // openDirectory: a .oscproj is a plain dir wherever LSTypeIsPackage
    // doesn't apply (dev runs, non-mac).
    const res = await dialog.showOpenDialog(win!, {
      defaultPath: projectDir ?? workdir,
      filters: [{ name: 'Project', extensions: ['oscproj', 'json'] }],
      properties: ['openFile', 'openDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : grantProjectPath(res.filePaths[0])
  })
  ipcMain.handle('project:saveDialog', async (e, defaultPath?: string) => {
    const fallback = defaultPath ?? join(projectDir ?? workdir, 'Untitled.oscproj')
    if (hidden) {
      // Empty OSC_EDITOR_DIALOG_PATH stands in for a cancelled dialog.
      const p = process.env.OSC_EDITOR_DIALOG_PATH
      return p === '' ? null : grantProjectPath(p ?? fallback)
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: fallback,
      filters: [{ name: 'Project', extensions: ['oscproj'] }]
    })
    return res.canceled || !res.filePath ? null : grantProjectPath(res.filePath)
  })
  ipcMain.handle('undo:load', () => loadUndoLog(undoDir()))
  ipcMain.handle('undo:append', (_e, entry: UndoEntry) =>
    appendUndo(undoDir(), entry, savedUndoSeq)
  )
  ipcMain.handle('undo:truncateAfter', (_e, seq: number) => truncateUndoAfter(undoDir(), seq))
  // Ask where to save; null = user cancelled. Hidden (e2e) skips the native
  // dialog — it would hang the test — and writes the default session.jsonl.
  ipcMain.handle('session:export', async (e, project: ProjectFile) => {
    // Default next to the project: a bundle's parent dir, not inside it.
    const exportDir =
      projectDir == null
        ? workdir
        : projectDir.endsWith('.oscproj')
          ? dirname(projectDir)
          : projectDir
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

  // Preview playback is delegated to vtr-player: inline-load the merged
  // project with routes, then drive the shared push transport. The player's
  // emit loop is the only preview emitter — one resolver serves preview,
  // file replay, and TD scrubs alike. Errors reject to the renderer's
  // banner; there is no editor-side fallback path anymore.
  const forwardPort = (): number => tap?.ports.forward ?? DEFAULT_PORTS.forward
  ipcMain.handle('preview:play', async (_e, project: ProjectFile, fromSec: number) => {
    const merged = mergeProject(resolveClip, project)
    const duration = Math.max(merged.duration, project.duration ?? 0)
    const p = requirePlayer()
    await p.loadInline(merged.events, duration, routesFor(merged.events, forwardPort()))
    await p.seek(fromSec)
    const transport = await p.play()
    return { duration, transport }
  })
  ipcMain.handle('preview:seek', (_e, fromSec: number) => requirePlayer().seek(fromSec))
  ipcMain.handle('preview:stop', async () => {
    const transport = await requirePlayer().stopTransport()
    return { position: transport.playhead }
  })
  // Session residency: keep the player holding the current merged project
  // even when idle, so a TD-side scrub resolves against something. Called
  // on project open and (debounced) after edits. Best-effort.
  // Seed for a freshly (re)loaded renderer: the last foreign transport
  // state, extrapolated while playing so the playhead lands where the
  // transport actually is, not where it was at the last gen bump.
  ipcMain.handle('transport:last', (): TransportState | null => {
    if (!lastTransport) return null
    const { state, at } = lastTransport
    if (!state.playing) return state
    return { ...state, playhead: state.playhead + (Date.now() - at) / 1000 }
  })
  ipcMain.handle('player:loadInline', (_e, project: ProjectFile) => {
    const merged = mergeProject(resolveClip, project)
    const duration = Math.max(merged.duration, project.duration ?? 0)
    player
      ?.loadInline(merged.events, duration, routesFor(merged.events, forwardPort()))
      .catch((e) => console.log(`residency load failed: ${(e as Error).message}`))
  })

  createWindow()

  // Finder open while the app is running: prompt when dirty, then hand the
  // path to the renderer to load.
  openAfterReady = (path) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (dirtyState) {
      const discard = hidden
        ? process.env.OSC_EDITOR_QUIT_CHOICE !== 'cancel'
        : dialog.showMessageBoxSync(win, {
            type: 'warning',
            buttons: ['Discard Changes and Open', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            message: 'You have unsaved changes.',
            detail: 'Opening another project will discard them.'
          }) === 0
      if (!discard) return
    }
    grantProjectPath(path)
    win.webContents.send('project:openPath', path)
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  transportFollow?.stop()
  tap?.shutdown()
  player?.shutdown()
})

app.on('window-all-closed', () => {
  app.quit()
})
