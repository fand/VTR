import { useEffect, useLayoutEffect, useRef } from 'react'

/** True when a keyboard event comes from a text field; global shortcuts must ignore it. */
export function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export interface ShortcutHandlers {
  openProject: () => void
  /** Resolves true only when the project actually saved. */
  saveProject: () => Promise<boolean>
  saveProjectAs: () => Promise<boolean>
  copySelected: () => void
  pasteAtPlayhead: () => void
  /** Cmd+D; no-op without a clip selection. */
  duplicateSelected: () => void
  togglePlay: () => void
  addMarker: () => void
  /** Delete/Backspace: selected curve points, else selected clips. */
  deleteSelected: () => void
  undo: () => void
  redo: () => void
  /** Space is disabled while recording. */
  recording: boolean
}

/**
 * Every window-level shortcut and its app-menu twin, one subscription.
 *
 * Open/save, copy/paste and undo/redo arrive two ways: the app menu (real
 * usage — its accelerators swallow the native keydown) and a keydown
 * fallback (synthetic input, e.g. e2e, never reaches menu accelerators).
 * Exactly one path fires per press. Space/M/Delete/Cmd+D have no menu
 * items: keydown only.
 *
 * Handlers are read through a ref updated in a layout effect, so the single
 * subscription never runs against a stale closure (a save fired right after
 * a commit must see the newest doc — same rule as App's saveState ref).
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers)
  useLayoutEffect(() => {
    ref.current = handlers
  })
  useEffect(() => {
    const offs = [
      window.api.menu.on('open', () => ref.current.openProject()),
      window.api.menu.on('save', () => void ref.current.saveProject()),
      window.api.menu.on('saveAs', () => void ref.current.saveProjectAs()),
      // Quit prompt chose Save: close only after a successful save, so a
      // cancelled Save As leaves the app open.
      window.api.menu.on('saveAndClose', async () => {
        if (await ref.current.saveProject()) window.api.window.confirmClose()
      }),
      // The Edit menu already did the native text-field action; these fire
      // for the app-level side only.
      window.api.menu.on('copy', () => {
        if (!isTextInput(document.activeElement)) ref.current.copySelected()
      }),
      window.api.menu.on('paste', () => {
        if (!isTextInput(document.activeElement)) ref.current.pasteAtPlayhead()
      }),
      window.api.menu.on('undo', () => {
        if (isTextInput(document.activeElement)) document.execCommand('undo')
        else ref.current.undo()
      }),
      window.api.menu.on('redo', () => {
        if (isTextInput(document.activeElement)) document.execCommand('redo')
        else ref.current.redo()
      })
    ]
    const onKey = (e: KeyboardEvent): void => {
      const h = ref.current
      const k = e.key.toLowerCase()
      if (e.metaKey || e.ctrlKey) {
        // File shortcuts work from inside a text field, like the menu.
        if (k === 'o') {
          e.preventDefault()
          h.openProject()
          return
        }
        if (k === 's') {
          e.preventDefault()
          void (e.shiftKey ? h.saveProjectAs() : h.saveProject())
          return
        }
        if (isTextInput(e.target)) return // native field editing wins
        if (k === 'z') {
          e.preventDefault()
          if (e.shiftKey) h.redo()
          else h.undo()
        } else if (k === 'c') h.copySelected()
        else if (k === 'v') h.pasteAtPlayhead()
        else if (k === 'd') {
          e.preventDefault()
          h.duplicateSelected()
        }
        return
      }
      if (e.code === 'Space') {
        if (h.recording || isTextInput(e.target)) return
        e.preventDefault()
        h.togglePlay()
        return
      }
      if (isTextInput(e.target)) return
      if (k === 'm' && !e.altKey) h.addMarker()
      else if (e.key === 'Delete' || e.key === 'Backspace') h.deleteSelected()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      for (const off of offs) off()
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}
