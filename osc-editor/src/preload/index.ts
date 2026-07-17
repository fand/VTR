import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ClipSummary,
  ExportResult,
  LoadedProject,
  OscEvent,
  PortConfig,
  ProjectFile,
  TapStatus,
  UndoEntry
} from '../shared/types'

const api = {
  tap: {
    start: (): Promise<string> => ipcRenderer.invoke('tap:start'),
    stop: (clipPath: string): Promise<ClipSummary> => ipcRenderer.invoke('tap:stop', clipPath),
    status: (): Promise<TapStatus> => ipcRenderer.invoke('tap:status'),
    setPorts: (ports: PortConfig): Promise<void> => ipcRenderer.invoke('tap:setPorts', ports)
  },
  clip: {
    events: (path: string): Promise<OscEvent[]> => ipcRenderer.invoke('clip:events', path),
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
      ipcRenderer.invoke('project:saveDialog', defaultPath)
  },
  session: {
    /** Resolves null when the user cancels the save dialog. */
    export: (project: ProjectFile): Promise<ExportResult | null> =>
      ipcRenderer.invoke('session:export', project)
  },
  preview: {
    play: (project: ProjectFile, fromSec: number): Promise<{ duration: number }> =>
      ipcRenderer.invoke('preview:play', project, fromSec),
    stop: (): Promise<{ position: number }> => ipcRenderer.invoke('preview:stop')
  },
  undo: {
    load: (): Promise<UndoEntry[]> => ipcRenderer.invoke('undo:load'),
    append: (entry: UndoEntry): Promise<void> => ipcRenderer.invoke('undo:append', entry),
    truncateAfter: (seq: number): Promise<void> => ipcRenderer.invoke('undo:truncateAfter', seq)
  },
  menu: {
    /** Subscribe to Edit-menu actions (menu accelerators eat their keydowns). */
    on: (
      channel: 'undo' | 'redo' | 'copy' | 'paste' | 'open' | 'save' | 'saveAs',
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
      ipcRenderer.invoke('window:setFile', path, dirty)
  },
  workdir: (): Promise<string> => ipcRenderer.invoke('app:workdir')
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
