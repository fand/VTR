import { BrowserWindow, ipcMain } from 'electron'
import type { AppContext } from './appContext'

export function registerWindowIpc(ctx: AppContext): void {
  ipcMain.handle('app:workdir', () => ctx.workdir)
  // macOS: proxy icon in the title bar carries the full path; the edited
  // state shows as a dot on the close button. No-ops on other platforms.
  ipcMain.handle('window:setFile', (e, path: string | null, dirty: boolean) => {
    ctx.dirtyState = dirty
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.setRepresentedFilename(path ?? '')
    win?.setDocumentEdited(dirty)
  })
  // The renderer saved after a quit prompt chose Save; finish the close.
  ipcMain.handle('window:confirmClose', (e) => {
    ctx.forceClose = true
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
}
