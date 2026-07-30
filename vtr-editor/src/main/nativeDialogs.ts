import { dialog } from 'electron'
import type { Dialogs, QuitChoice } from './dialogs'

export const nativeDialogs: Dialogs = {
  quitChoice: (win) => {
    const byIndex: QuitChoice[] = ['save', 'discard', 'cancel']
    return byIndex[
      dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'You have unsaved changes.',
        detail: 'Your changes will be lost if you close without saving.'
      })
    ]
  },
  confirmDiscardForOpen: (win) =>
    dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard Changes and Open', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Opening another project will discard them.'
    }) === 0,
  warnMissingProject: (win, path) => {
    dialog.showMessageBoxSync(win, {
      type: 'warning',
      message: 'Project not found.',
      detail: path
    })
  },
  openProject: async (win, defaultDir) => {
    // openDirectory: a .oscproj is a plain dir wherever LSTypeIsPackage
    // doesn't apply (dev runs, non-mac).
    const res = await dialog.showOpenDialog(win, {
      defaultPath: defaultDir,
      filters: [{ name: 'Project', extensions: ['oscproj', 'json'] }],
      properties: ['openFile', 'openDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  },
  saveProject: async (win, fallback) => {
    const res = await dialog.showSaveDialog(win, {
      defaultPath: fallback,
      filters: [{ name: 'Project', extensions: ['oscproj'] }]
    })
    return res.canceled || !res.filePath ? null : res.filePath
  },
  exportSessionPath: async (win, defaultPath) => {
    const res = await dialog.showSaveDialog(win, {
      defaultPath,
      filters: [{ name: 'JSONL', extensions: ['jsonl'] }]
    })
    return res.canceled || !res.filePath ? null : res.filePath
  }
}
