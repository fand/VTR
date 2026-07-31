import React, { useEffect, useRef, useState } from 'react'

export function NumField({
  label,
  ariaLabel,
  value,
  disabled,
  parse,
  onCommit,
  onInput,
  dragStep
}: {
  label: string
  ariaLabel: string
  value: number
  disabled?: boolean
  /** Returns the validated number, or null to reject. */
  parse: (draft: string) => number | null
  onCommit: (n: number) => void
  /** Transient value while dragging; the release fires onCommit once. Without
   *  it every drag step commits (fine for ports, which have no history). */
  onInput?: (n: number) => void
  /** Units per px of horizontal drag on the label. Omit to disable dragging. */
  dragStep?: number
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = parse(draft)
    if (n != null && n !== value) onCommit(n)
    else setDraft(String(value))
  }
  // Unfocused input acts as a drag handle; a plain click focuses it for typing.
  const drag = useRef<{ x: number; start: number; moved: boolean; last: number } | null>(null)
  const dragProps =
    dragStep && !disabled
      ? {
          className: 'draggable',
          onPointerDown: (e: React.PointerEvent<HTMLInputElement>) => {
            if (document.activeElement === e.currentTarget) return // normal editing
            e.preventDefault() // don't focus yet; wait to see if it's a drag
            drag.current = { x: e.clientX, start: value, moved: false, last: value }
            e.currentTarget.setPointerCapture(e.pointerId)
          },
          onPointerMove: (e: React.PointerEvent<HTMLInputElement>) => {
            const d = drag.current
            if (!d) return
            const dx = e.clientX - d.x
            if (!d.moved && Math.abs(dx) < 3) return
            d.moved = true
            const n = parse(String(Math.round((d.start + dx * dragStep) / dragStep) * dragStep))
            if (n != null && n !== d.last) {
              d.last = n
              ;(onInput ?? onCommit)(n)
            }
          },
          onPointerUp: (e: React.PointerEvent<HTMLInputElement>) => {
            const d = drag.current
            drag.current = null
            if (!d) return
            if (!d.moved) {
              e.currentTarget.focus()
              e.currentTarget.select()
            } else if (onInput && d.last !== d.start) {
              onCommit(d.last)
            }
          },
          // Cancelled scrub: commit the last streamed value (like release),
          // so no transient is left dangling. No focus on cancel.
          onPointerCancel: () => {
            const d = drag.current
            drag.current = null
            if (d?.moved && onInput && d.last !== d.start) onCommit(d.last)
          }
        }
      : {}
  return (
    <label className="port-field">
      <span className="port-field-label">{label}</span>
      <input
        value={draft}
        disabled={disabled ?? false}
        inputMode="numeric"
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        {...dragProps}
      />
    </label>
  )
}

/** Same shell as NumField, for free text. No drag handle. */
export function TextField({
  label,
  ariaLabel,
  value,
  placeholder,
  disabled,
  valid,
  onCommit
}: {
  label: string
  ariaLabel: string
  value: string
  placeholder?: string
  disabled?: boolean
  /** Rejects the draft on commit, restoring the last good value. */
  valid: (draft: string) => boolean
  onCommit: (v: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    const next = draft.trim()
    if (valid(next) && next !== value) onCommit(next)
    else setDraft(value)
  }
  return (
    <label className="port-field text-field">
      <span className="port-field-label">{label}</span>
      <input
        value={draft}
        disabled={disabled ?? false}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </label>
  )
}
