import React, { useEffect, useRef, useState } from 'react'

/** Header "File" dropdown, next to the logo. Accelerators live in the app menu. */
export function FileMenu({
  onOpen,
  onSave,
  onSaveAs,
  onExport,
  exportDisabled
}: {
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onExport: () => void
  exportDisabled: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<{ path: string; label: string }[]>([])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    window.api.recents.list().then(setRecents)
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])
  const item = (
    label: string,
    shortcut: string,
    fn: () => void,
    disabled = false
  ): React.JSX.Element => (
    <button
      className="file-menu-item"
      disabled={disabled}
      onClick={() => {
        setOpen(false)
        fn()
      }}
    >
      <span>{label}</span>
      <span className="file-menu-shortcut">{shortcut}</span>
    </button>
  )
  return (
    <div className="file-menu" ref={ref}>
      <button className="file-menu-trigger" onClick={() => setOpen((o) => !o)}>
        File
      </button>
      {open && (
        <div className="file-menu-dropdown">
          {item('Open…', '⌘O', onOpen)}
          <div className="file-menu-sub">
            <div className="file-menu-item">
              <span>Open Recent</span>
              <span className="file-menu-shortcut">▸</span>
            </div>
            <div className="file-menu-dropdown file-menu-flyout">
              {recents.map((r) => (
                <button
                  key={r.path}
                  className="file-menu-item"
                  onClick={() => {
                    setOpen(false)
                    window.api.recents.open(r.path)
                  }}
                >
                  <span>{r.label}</span>
                </button>
              ))}
              {recents.length > 0 && <div className="file-menu-separator" />}
              {item(
                'Clear Menu',
                '',
                () => {
                  window.api.recents.clear()
                },
                recents.length === 0
              )}
            </div>
          </div>
          {item('Save', '⌘S', onSave)}
          {item('Save As…', '⇧⌘S', onSaveAs)}
          {item('Export', '', onExport, exportDisabled)}
        </div>
      )}
    </div>
  )
}
