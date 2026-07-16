import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ClipInst, MIN_CLIP_LEN, TrackState, clipLen, contentEnd } from '../timeline/model'

export interface PlayingState {
  startPos: number
  /** performance.now() when playback started. */
  startedAt: number
  duration: number
}

export const TRACK_HEIGHT = 64
const TRIM_HANDLE_PX = 8
const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]

type DragMode = 'move' | 'trim-in' | 'trim-out'

export type ClipAction = 'mute' | 'copy' | 'paste' | 'duplicate' | 'split'

interface Drag {
  mode: DragMode
  clipId: number
  fromTrack: number
  startX: number
  startY: number
  orig: ClipInst
  /** Set once past the click threshold; a plain click never commits. */
  moved: boolean
}

interface TimelineProps {
  tracks: TrackState[]
  pxPerSec: number
  /** Timeline length, seconds (the view extends to at least this). */
  duration: number
  selectedId: number | null
  recordingRow: { events: number } | null
  playhead: number
  playing: PlayingState | null
  onSeek: (sec: number) => void
  onSelect: (id: number | null) => void
  onTracksChange: (tracks: TrackState[], commit: boolean) => void
  onAddTrack: () => void
  onDeleteTrack: (trackId: number) => void
  onRenameTrack: (trackId: number, name: string) => void
  onRenameClip: (clipId: number, name: string) => void
  /** Context-menu action on a clip; paste lands on that clip's track. */
  onClipAction: (action: ClipAction, clipId: number) => void
  /** False disables Paste (nothing copied yet). */
  canPaste: boolean
  /** Pinch/ctrl-wheel zoom; factor > 1 zooms in. The caller clamps. */
  onZoom: (factor: number) => void
}

const LABEL_W = 96

/**
 * Double-click to edit. Enter/blur commits, Escape cancels, empty resets.
 * Editing state lives in the parent: a clip's pointer capture retargets the
 * dblclick to the clip div, so the clip must be able to start the edit too.
 */
export function EditableLabel({
  value,
  placeholder,
  ariaLabel,
  editing,
  onEditStart,
  onEditEnd,
  onRename
}: {
  value: string | undefined
  placeholder: string
  ariaLabel: string
  editing: boolean
  onEditStart: () => void
  onEditEnd: () => void
  onRename: (name: string) => void
}): React.JSX.Element {
  const cancelled = useRef(false)
  if (!editing) {
    return (
      <span className="editable-label" title="double-click to rename" onDoubleClick={onEditStart}>
        {value ?? placeholder}
      </span>
    )
  }
  return (
    <input
      className="rename-input"
      autoFocus
      defaultValue={value ?? ''}
      aria-label={ariaLabel}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
      onBlur={(e) => {
        const name = e.currentTarget.value.trim()
        const wasCancelled = cancelled.current
        cancelled.current = false
        onEditEnd()
        if (!wasCancelled && name !== (value ?? '')) onRename(name)
      }}
    />
  )
}

function PlayheadLine({
  playhead,
  playing,
  pxPerSec
}: {
  playhead: number
  playing: PlayingState | null
  pxPerSec: number
}): React.JSX.Element {
  const [, force] = useState(0)
  useEffect(() => {
    if (!playing) return
    let raf: number
    const loop = (): void => {
      force((x) => x + 1)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing])
  const sec = playing
    ? Math.min(playing.startPos + (performance.now() - playing.startedAt) / 1000, playing.duration)
    : playhead
  return <div className="playhead" style={{ left: LABEL_W + sec * pxPerSec }} />
}

function rulerStep(pxPerSec: number): number {
  for (const s of RULER_STEPS) {
    if (s * pxPerSec >= 70) return s
  }
  return RULER_STEPS[RULER_STEPS.length - 1]
}

function formatRulerLabel(s: number): string {
  if (s >= 60) {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return sec === 0 ? `${m}m` : `${m}m${sec.toFixed(0)}`
  }
  return s < 1 ? s.toFixed(2).replace(/0$/, '') : `${s.toFixed(0)}s`
}

export function Timeline({
  tracks,
  pxPerSec,
  duration,
  selectedId,
  recordingRow,
  playhead,
  playing,
  onSeek,
  onSelect,
  onTracksChange,
  onAddTrack,
  onDeleteTrack,
  onRenameTrack,
  onRenameClip,
  onClipAction,
  canPaste,
  onZoom
}: TimelineProps): React.JSX.Element {
  const drag = useRef<Drag | null>(null)
  // Vertical move preview: the clip stays in its DOM parent during the drag
  // (re-parenting would kill pointer capture) and is shifted with translateY.
  const [dragRow, setDragRow] = useState<{ clipId: number; delta: number } | null>(null)
  const [renaming, setRenaming] = useState<{ kind: 'track' | 'clip'; id: number } | null>(null)
  // Right-click menu; the snapshot of the clip drives item labels/enabling.
  const [menu, setMenu] = useState<{ x: number; y: number; clip: ClipInst } | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Time + viewport x under the cursor at pinch start; scroll is restored
  // after the zoomed width renders so that point stays put.
  const pinchAnchor = useRef<{ t: number; viewX: number } | null>(null)

  // macOS pinch arrives as ctrl+wheel; preventDefault needs a non-passive
  // listener, which React's onWheel doesn't provide.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const viewX = e.clientX - el.getBoundingClientRect().left
      pinchAnchor.current = { t: (el.scrollLeft + viewX - LABEL_W) / pxPerSec, viewX }
      onZoom(Math.exp(-e.deltaY * 0.01))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [pxPerSec, onZoom])

  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = pinchAnchor.current
    if (!el || !a) return
    pinchAnchor.current = null
    el.scrollLeft = LABEL_W + a.t * pxPerSec - a.viewX
  }, [pxPerSec])

  const applyDrag = (e: React.PointerEvent, commit: boolean): void => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.startX) / pxPerSec
    const dy = e.clientY - d.startY
    const orig = d.orig

    const updated: ClipInst = { ...orig }
    let targetTrack = d.fromTrack
    if (d.mode === 'move') {
      updated.offset = Math.max(0, orig.offset + dx)
      const rowDelta = Math.round(dy / TRACK_HEIGHT)
      targetTrack = Math.min(Math.max(d.fromTrack + rowDelta, 0), tracks.length - 1)
      setDragRow(commit ? null : { clipId: d.clipId, delta: targetTrack - d.fromTrack })
    }
    if (d.mode === 'trim-in') {
      const delta = Math.min(
        Math.max(dx, -Math.min(orig.trimIn, orig.offset)),
        clipLen(orig) - MIN_CLIP_LEN
      )
      updated.trimIn = orig.trimIn + delta
      updated.offset = orig.offset + delta
    }
    if (d.mode === 'trim-out') {
      updated.trimOut = Math.min(
        Math.max(orig.trimOut + dx, orig.trimIn + MIN_CLIP_LEN),
        orig.summary.duration
      )
    }

    // Re-parent to the target track only on commit.
    const insertInto = commit ? targetTrack : d.fromTrack
    const next = tracks.map((track, i) => {
      const without = track.clips.filter((c) => c.id !== d.clipId)
      const clips = i === insertInto ? [...without, updated] : without
      return { ...track, clips }
    })
    onTracksChange(next, commit)
  }

  const onClipPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    clip: ClipInst,
    trackIdx: number
  ): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    onSelect(clip.id)
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const mode: DragMode =
      x < TRIM_HANDLE_PX ? 'trim-in' : x > rect.width - TRIM_HANDLE_PX ? 'trim-out' : 'move'
    drag.current = {
      mode,
      clipId: clip.id,
      fromTrack: trackIdx,
      startX: e.clientX,
      startY: e.clientY,
      orig: clip,
      moved: false
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onClipPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientX - d.startX) < 3 && Math.abs(e.clientY - d.startY) < 3) {
      return
    }
    d.moved = true
    applyDrag(e, false)
  }

  const onClipPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    if (d.moved) applyDrag(e, true)
    drag.current = null
    setDragRow(null)
  }

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const menuAction = (action: ClipAction): void => {
    if (menu) onClipAction(action, menu.clip.id)
    setMenu(null)
  }

  const end = Math.max(duration, contentEnd(tracks))
  const widthPx = Math.max(end * pxPerSec, 600)
  const step = rulerStep(pxPerSec)
  const marks: number[] = []
  for (let s = 0; s <= end; s += step) marks.push(Math.round(s * 1e6) / 1e6)

  return (
    <div className="timeline-scroll" ref={scrollRef} onPointerDown={() => onSelect(null)}>
      <div className="tl-content" style={{ width: widthPx + 96 }}>
        <div className="ruler-row">
          <div className="track-label ruler-corner" />
          <div
            className="ruler"
            style={{ width: widthPx }}
            onPointerDown={(e) => {
              e.stopPropagation()
              if (e.button !== 0) return
              e.currentTarget.setPointerCapture(e.pointerId)
              const rect = e.currentTarget.getBoundingClientRect()
              onSeek(Math.max(0, (e.clientX - rect.left) / pxPerSec))
            }}
            onPointerMove={(e) => {
              if ((e.buttons & 1) === 0) return
              const rect = e.currentTarget.getBoundingClientRect()
              onSeek(Math.max(0, (e.clientX - rect.left) / pxPerSec))
            }}
          >
            {marks.map((s) => (
              <div key={s} className="ruler-mark" style={{ left: s * pxPerSec }}>
                {formatRulerLabel(s)}
              </div>
            ))}
          </div>
        </div>

        <PlayheadLine playhead={playhead} playing={playing} pxPerSec={pxPerSec} />

        {tracks.map((track, trackIdx) => (
          <div className="track" key={track.id} style={{ height: TRACK_HEIGHT }}>
            <div className="track-label">
              <EditableLabel
                value={track.name}
                placeholder={`Track ${trackIdx + 1}`}
                ariaLabel={`rename track ${trackIdx + 1}`}
                editing={renaming?.kind === 'track' && renaming.id === track.id}
                onEditStart={() => setRenaming({ kind: 'track', id: track.id })}
                onEditEnd={() => setRenaming(null)}
                onRename={(name) => onRenameTrack(track.id, name)}
              />
              <button
                className="track-del"
                title="delete track"
                aria-label={`delete track ${trackIdx + 1}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onDeleteTrack(track.id)}
              >
                ×
              </button>
            </div>
            <div
              className="track-lane"
              style={{ width: widthPx }}
              onPointerDown={(e) => {
                // Clip drags call stopPropagation, so this is an empty-lane
                // click — or a right-click on a clip bubbling up; seek on
                // the primary button only.
                if (e.button !== 0) return
                const rect = e.currentTarget.getBoundingClientRect()
                onSeek(Math.max(0, (e.clientX - rect.left) / pxPerSec))
              }}
            >
              {track.clips.map((clip) => (
                <div
                  key={clip.id}
                  className={
                    'clip' +
                    (clip.id === selectedId ? ' selected' : '') +
                    (clip.muted ? ' muted' : '')
                  }
                  style={{
                    left: clip.offset * pxPerSec,
                    width: Math.max(clipLen(clip) * pxPerSec, 12),
                    ...(dragRow?.clipId === clip.id && {
                      transform: `translateY(${dragRow.delta * TRACK_HEIGHT}px)`,
                      zIndex: 10
                    })
                  }}
                  onPointerDown={(e) => onClipPointerDown(e, clip, trackIdx)}
                  onPointerMove={onClipPointerMove}
                  onPointerUp={onClipPointerUp}
                  // Pointer capture retargets the dblclick from the label
                  // span to this div, so the rename trigger lives here.
                  onDoubleClick={() => setRenaming({ kind: 'clip', id: clip.id })}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    onSelect(clip.id)
                    setMenu({ x: e.clientX, y: e.clientY, clip })
                  }}
                >
                  <span className="clip-name">
                    <EditableLabel
                      value={clip.name}
                      placeholder={clip.file}
                      ariaLabel={`rename clip ${clip.file}`}
                      editing={renaming?.kind === 'clip' && renaming.id === clip.id}
                      onEditStart={() => setRenaming({ kind: 'clip', id: clip.id })}
                      onEditEnd={() => setRenaming(null)}
                      onRename={(name) => onRenameClip(clip.id, name)}
                    />
                  </span>
                  <span className="clip-meta">
                    {clipLen(clip).toFixed(1)}s · {clip.summary.events} ev
                    {clip.summary.tlOffset != null && ' · tl'}
                  </span>
                  <div className="trim-handle trim-in" />
                  <div className="trim-handle trim-out" />
                </div>
              ))}
            </div>
          </div>
        ))}

        {recordingRow && (
          <div className="track" style={{ height: TRACK_HEIGHT }}>
            <div className="track-label">Track {tracks.length + 1}</div>
            <div className="track-lane" style={{ width: widthPx }}>
              <div className="clip recording" style={{ left: 0, width: 160 }}>
                <span className="clip-name">recording…</span>
                <span className="clip-meta">{recordingRow.events} ev</span>
              </div>
            </div>
          </div>
        )}

        <div className="add-track">
          <button
            className="btn small"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onAddTrack}
          >
            + Track
          </button>
        </div>

        {tracks.length === 0 && !recordingRow && (
          <div className="empty">No clips. Hit ● Rec to record incoming OSC.</div>
        )}
      </div>

      {menu && (
        <div
          className="ctx-overlay"
          onPointerDown={(e) => {
            e.stopPropagation()
            setMenu(null)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu(null)
          }}
        >
          <div
            className="ctx-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button role="menuitem" onClick={() => menuAction('mute')}>
              {menu.clip.muted ? 'Unmute' : 'Mute'}
            </button>
            <button role="menuitem" onClick={() => menuAction('copy')}>
              Copy
            </button>
            <button role="menuitem" disabled={!canPaste} onClick={() => menuAction('paste')}>
              Paste
            </button>
            <button role="menuitem" onClick={() => menuAction('duplicate')}>
              Duplicate
            </button>
            <button
              role="menuitem"
              disabled={
                playhead < menu.clip.offset + MIN_CLIP_LEN ||
                playhead > menu.clip.offset + clipLen(menu.clip) - MIN_CLIP_LEN
              }
              onClick={() => menuAction('split')}
            >
              Split at playhead
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
