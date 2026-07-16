import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ClipSummary,
  ExportResult,
  LoadedProject,
  PortConfig,
  ProjectFile,
  TapStatus
} from '../shared/types'

const api = {
  tap: {
    start: (): Promise<string> => ipcRenderer.invoke('tap:start'),
    stop: (clipPath: string): Promise<ClipSummary> => ipcRenderer.invoke('tap:stop', clipPath),
    status: (): Promise<TapStatus> => ipcRenderer.invoke('tap:status'),
    setPorts: (ports: PortConfig): Promise<void> => ipcRenderer.invoke('tap:setPorts', ports)
  },
  project: {
    load: (): Promise<LoadedProject | null> => ipcRenderer.invoke('project:load'),
    save: (project: ProjectFile): Promise<void> => ipcRenderer.invoke('project:save', project)
  },
  session: {
    export: (project: ProjectFile): Promise<ExportResult> =>
      ipcRenderer.invoke('session:export', project)
  },
  preview: {
    play: (project: ProjectFile, fromSec: number): Promise<{ duration: number }> =>
      ipcRenderer.invoke('preview:play', project, fromSec),
    stop: (): Promise<{ position: number }> => ipcRenderer.invoke('preview:stop')
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
