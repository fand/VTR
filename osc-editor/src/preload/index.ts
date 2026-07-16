import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ClipSummary, TapStatus } from '../shared/types'

const api = {
  tap: {
    start: (): Promise<string> => ipcRenderer.invoke('tap:start'),
    stop: (clipPath: string): Promise<ClipSummary> => ipcRenderer.invoke('tap:stop', clipPath),
    status: (): Promise<TapStatus> => ipcRenderer.invoke('tap:status')
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
