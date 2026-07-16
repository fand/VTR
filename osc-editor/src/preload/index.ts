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
    events: (path: string): Promise<OscEvent[]> => ipcRenderer.invoke('clip:events', path)
  },
  project: {
    load: (): Promise<LoadedProject | null> => ipcRenderer.invoke('project:load'),
    save: (project: ProjectFile): Promise<void> => ipcRenderer.invoke('project:save', project)
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
    on: (channel: 'undo' | 'redo' | 'copy' | 'paste', cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(`menu:${channel}`, listener)
      return () => ipcRenderer.removeListener(`menu:${channel}`, listener)
    }
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
