import type { BrowserWindow } from 'electron'

export type QuitChoice = 'save' | 'discard' | 'cancel'

/**
 * Every user-facing prompt the main process shows. Picked once at boot:
 * native dialogs normally, the OSC_EDITOR_* env stand-ins when hidden
 * (e2e) — a native dialog would hang the test.
 */
export interface Dialogs {
  /** Close with unsaved changes: save / discard / cancel. */
  quitChoice(win: BrowserWindow): QuitChoice
  /** Open another project while dirty; true = discard and open. */
  confirmDiscardForOpen(win: BrowserWindow): boolean
  /** A recent-menu entry points at a project that no longer exists. */
  warnMissingProject(win: BrowserWindow, path: string): void
  /** Pick a project to open; null = cancelled. */
  openProject(win: BrowserWindow, defaultDir: string): Promise<string | null>
  /** Pick a project save path; null = cancelled. */
  saveProject(win: BrowserWindow, fallback: string): Promise<string | null>
  /** Pick a session.jsonl export path; null = cancelled. */
  exportSessionPath(win: BrowserWindow, defaultPath: string): Promise<string | null>
}

/**
 * e2e stand-ins. OSC_EDITOR_QUIT_CHOICE drives the prompts (default
 * discard, matching the documented no-autosave quit); OSC_EDITOR_DIALOG_PATH
 * stands in for the user's pick — unset means "no pick" (open cancels,
 * save falls back to the suggested path), empty means cancelled.
 */
export const envDialogs: Dialogs = {
  quitChoice: () => {
    const c = process.env.OSC_EDITOR_QUIT_CHOICE
    return c === 'save' || c === 'cancel' ? c : 'discard'
  },
  confirmDiscardForOpen: () => process.env.OSC_EDITOR_QUIT_CHOICE !== 'cancel',
  warnMissingProject: () => {},
  openProject: async () => process.env.OSC_EDITOR_DIALOG_PATH || null,
  saveProject: async (_win, fallback) => {
    const p = process.env.OSC_EDITOR_DIALOG_PATH
    return p === '' ? null : (p ?? fallback)
  },
  exportSessionPath: async (_win, defaultPath) => defaultPath
}
