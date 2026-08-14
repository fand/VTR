import { contextBridge, ipcRenderer } from 'electron'
import type {
  ClipSummary,
  ExportResult,
  LoadedProject,
  MergeClipResult,
  MonitorLine,
  OscEvent,
  PlayerStatus,
  PortConfig,
  ProjectFile,
  TapPush,
  TapStatus,
  TransportState,
  UndoEntry
} from '../shared/types'

const api = {
  tap: {
    start: (): Promise<string> => ipcRenderer.invoke('tap:start'),
    stop: (): Promise<void> => ipcRenderer.invoke('tap:stop'),
    status: (): Promise<TapStatus> => ipcRenderer.invoke('tap:status'),
    setPorts: (ports: PortConfig): Promise<void> => ipcRenderer.invoke('tap:setPorts', ports),
    /** Recording events and baseline/reset snapshots from the tap wait loop. */
    onEvent: (cb: (msg: TapPush) => void): (() => void) => {
      const listener = (_e: unknown, msg: TapPush): void => cb(msg)
      ipcRenderer.on('tap:event', listener)
      return () => ipcRenderer.removeListener('tap:event', listener)
    },
    /** Live OSC monitor lines, batched by the tap monitor loop. */
    onMonitor: (cb: (lines: MonitorLine[]) => void): (() => void) => {
      const listener = (_e: unknown, lines: MonitorLine[]): void => cb(lines)
      ipcRenderer.on('tap:monitor', listener)
      return () => ipcRenderer.removeListener('tap:monitor', listener)
    }
  },
  player: {
    status: (): Promise<PlayerStatus> => ipcRenderer.invoke('player:status'),
    /** Keep the player holding the current project so TD-side scrubs resolve. */
    loadInline: (project: ProjectFile): Promise<void> =>
      ipcRenderer.invoke('player:loadInline', project)
  },
  clip: {
    events: (path: string): Promise<OscEvent[]> => ipcRenderer.invoke('clip:events', path),
    summary: (path: string): Promise<ClipSummary> => ipcRenderer.invoke('clip:summary', path),
    /** Bake the sub-project (the selected clips) into one new clip file. */
    merge: (project: ProjectFile): Promise<MergeClipResult> =>
      ipcRenderer.invoke('clip:merge', project),
    reveal: (file: string): Promise<void> => ipcRenderer.invoke('clip:reveal', file)
  },
  project: {
    /** Boot load: the workdir's project.json (if any). */
    load: (): Promise<{ path: string; project: LoadedProject } | null> =>
      ipcRenderer.invoke('project:load'),
    loadPath: (path: string): Promise<{ path: string; project: LoadedProject }> =>
      ipcRenderer.invoke('project:loadPath', path),
    save: (path: string, project: ProjectFile): Promise<void> =>
      ipcRenderer.invoke('project:save', path, project),
    /** Resolve null when the user cancels. */
    openDialog: (): Promise<string | null> => ipcRenderer.invoke('project:openDialog'),
    saveDialog: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke('project:saveDialog', defaultPath),
    /** Finder opened a project while the app is running. */
    onOpenPath: (cb: (path: string) => void): (() => void) => {
      const listener = (_e: unknown, path: string): void => cb(path)
      ipcRenderer.on('project:openPath', listener)
      return () => ipcRenderer.removeListener('project:openPath', listener)
    }
  },
  recents: {
    /** Recent projects, most recent first, with display labels. */
    list: (): Promise<{ path: string; label: string }[]> => ipcRenderer.invoke('recents:list'),
    /** Open a recent project (must be a path from list()). */
    open: (path: string): Promise<void> => ipcRenderer.invoke('recents:open', path),
    clear: (): Promise<void> => ipcRenderer.invoke('recents:clear')
  },
  session: {
    /** Resolves null when the user cancels the save dialog. */
    export: (project: ProjectFile): Promise<ExportResult | null> =>
      ipcRenderer.invoke('session:export', project)
  },
  preview: {
    /** Load + seek + play on the shared transport; the reply snapshot is the truth. */
    play: (
      project: ProjectFile,
      fromSec: number
    ): Promise<{ duration: number; transport: TransportState }> =>
      ipcRenderer.invoke('preview:play', project, fromSec),
    /** Seek the shared transport (the player emits the resolved frame). */
    seek: (fromSec: number): Promise<TransportState> => ipcRenderer.invoke('preview:seek', fromSec),
    stop: (): Promise<{ position: number }> => ipcRenderer.invoke('preview:stop'),
    /** Foreign transport moves (TD/controller seek or play/stop) to follow. */
    onTransport: (cb: (state: TransportState) => void): (() => void) => {
      const listener = (_e: unknown, state: TransportState): void => cb(state)
      ipcRenderer.on('transport:update', listener)
      return () => ipcRenderer.removeListener('transport:update', listener)
    },
    /** Last foreign transport state (extrapolated), to seed a fresh renderer. */
    lastTransport: (): Promise<TransportState | null> => ipcRenderer.invoke('transport:last')
  },
  undo: {
    load: (): Promise<UndoEntry[]> => ipcRenderer.invoke('undo:load'),
    append: (entry: UndoEntry): Promise<void> => ipcRenderer.invoke('undo:append', entry),
    truncateAfter: (seq: number): Promise<void> => ipcRenderer.invoke('undo:truncateAfter', seq)
  },
  menu: {
    /** Subscribe to Edit-menu actions (menu accelerators eat their keydowns). */
    on: (
      channel: 'undo' | 'redo' | 'copy' | 'paste' | 'open' | 'save' | 'saveAs' | 'saveAndClose',
      cb: () => void
    ): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(`menu:${channel}`, listener)
      return () => ipcRenderer.removeListener(`menu:${channel}`, listener)
    }
  },
  window: {
    /** macOS proxy icon (full path) + edited dot; a no-op elsewhere. */
    setFile: (path: string | null, dirty: boolean): Promise<void> =>
      ipcRenderer.invoke('window:setFile', path, dirty),
    /** Quit prompt chose Save and the save succeeded: finish closing. */
    confirmClose: (): Promise<void> => ipcRenderer.invoke('window:confirmClose')
  },
  workdir: (): Promise<string> => ipcRenderer.invoke('app:workdir'),
  /** Renderer layout depends on it (macOS traffic-light inset). */
  platform: process.platform
}

export type Api = typeof api

// Only the typed api crosses the bridge: the generic electronAPI (raw
// ipcRenderer.invoke/send on any channel) stays out of the page world.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
