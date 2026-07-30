import { ipcMain } from 'electron'
import { appendUndo, loadUndoLog, truncateUndoAfter } from './undo'
import type { AppContext } from './appContext'
import type { UndoEntry } from '../shared/types'

export function registerUndoIpc(ctx: AppContext): void {
  ipcMain.handle('undo:load', () => loadUndoLog(ctx.undoDir()))
  ipcMain.handle('undo:append', (_e, entry: UndoEntry) =>
    appendUndo(ctx.undoDir(), entry, ctx.savedUndoSeq)
  )
  ipcMain.handle('undo:truncateAfter', (_e, seq: number) => truncateUndoAfter(ctx.undoDir(), seq))
}
