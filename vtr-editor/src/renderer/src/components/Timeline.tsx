import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlignStartVertical, BookmarkPlus, Magnet, ZoomIn, ZoomOut } from 'lucide-react'
import {
  ClipInst,
  MIN_CLIP_LEN,
  MarkerState,
  TrackState,
  clipLen,
  contentEnd,
  formatRulerLabel,
  recordingWarning
} from '../timeline/model'
import { useElementSize, zoomSlider } from './uiScale'

export interface PlayingState {
  startPos: number
  /** performance.now() when playback started. */
  startedAt: number
  duration: number
  /**
   * Playback started by TD or a controller, not the editor. The player
   * emits the OSC either way; the flag only exempts the end-of-project
   * auto-pause (it would stop the shared transport that someone else is
   * driving).
   */
  remote?: boolean
}

export const TRACK_HEIGHT = 64
/** .ruler-row height in main.css; tracks stack right below it. */
const RULER_H = 22
export const MIN_PX_PER_SEC = 2
export const MAX_PX_PER_SEC = 400
const TRIM_HANDLE_PX = 8
const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]

type DragMode = 'move' | 'trim-in' | 'trim-out'

export type ClipAction = 'mute' | 'copy' | 'paste' | 'duplicate' | 'split' | 'reveal'

interface Drag {
  mode: DragMode
  clipId: number
  startX: number
  startY: number
  orig: ClipInst
  /** Every clip moving with this drag (the whole selection), move mode only. */
  origs: { clip: ClipInst; trackIdx: number }[]
  /** True when the grabbed clip was already selected before pointerdown. */
  wasSelected: boolean
  /** Set once past the click threshold; a plain click never commits. */
  moved: boolean
}

interface TimelineProps {
  tracks: TrackState[]
  markers: MarkerState[]
  pxPerSec: number
  /** Zoom floor; shrinks below MIN_PX_PER_SEC so a long timeline still fits. */
  minPxPerSec: number
  /** Timeline length, seconds (the view extends to at least this). */
  duration: number
  selectedIds: number[]
  selectedTrackIds: number[]
  recordingRow: { events: number; warning: string | null } | null
  playhead: number
  playing: PlayingState | null
  onSeek: (sec: number) => void
  /** Additive select (shift/cmd-click) toggles membership. */
  onSelect: (id: number | null, additive?: boolean) => void
  /** Marquee select: replaces the clip selection with the given set. */
  onSelectMany: (ids: number[]) => void
  /** Track label click; additive (shift/cmd) toggles membership. */
  onSelectTrack: (trackId: number, additive: boolean) => void
  onTracksChange: (tracks: TrackState[], commit: boolean) => void
  /** pointercancel mid-drag: discard the uncommitted transient doc. */
  onDragCancel: () => void
  onAddTrack: () => void
  /** Add a marker at the playhead. */
  onAddMarker: () => void
  /** Place all clips at their TD timeline position (tl). */
  onAlign: () => void
  /** False disables Align (no clip has a tl). */
  canAlign: boolean
  onDeleteTrack: (trackId: number) => void
  onRenameTrack: (trackId: number, name: string) => void
  onRenameClip: (clipId: number, name: string) => void
  onRenameMarker: (markerId: number, label: string) => void
  onMarkersChange: (markers: MarkerState[], commit: boolean) => void
  onDeleteMarker: (markerId: number) => void
  /** Context-menu action on a clip; paste lands on that clip's track. */
  onClipAction: (action: ClipAction, clipId: number) => void
  /** False disables Paste (nothing copied yet). */
  canPaste: boolean
  /** Pinch/ctrl-wheel zoom; factor > 1 zooms in. The caller clamps. */
  onZoom: (factor: number) => void
  /** Absolute zoom from the header slider. The caller clamps. */
  onPxPerSecChange: (px: number) => void
  /** Timeline time under the pointer; null when off the lanes/ruler. */
  onHoverTime?: (sec: number | null) => void
}

export const LABEL_W = 96
/** Extra space after the last clip so the timeline's right edge stays visible. */
export const TAIL_PAD = 100
/** Snap radius, px: clip edges closer than this lock together. */
const SNAP_PX = 8

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
      <span
        className="editable-label"
        data-tip="double-click to rename"
        onDoubleClick={onEditStart}
      >
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
  return (
    <div className="playhead" style={{ left: LABEL_W + sec * pxPerSec }}>
      <div className="playhead-head" />
    </div>
  )
}

function rulerStep(pxPerSec: number): number {
  for (const s of RULER_STEPS) {
    if (s * pxPerSec >= 90) return s
  }
  return RULER_STEPS[RULER_STEPS.length - 1]
}

export function Timeline({
  tracks,
  markers,
  pxPerSec,
  minPxPerSec,
  duration,
  selectedIds,
  selectedTrackIds,
  recordingRow,
  playhead,
  playing,
  onSeek,
  onSelect,
  onSelectMany,
  onSelectTrack,
  onTracksChange,
  onDragCancel,
  onAddTrack,
  onAddMarker,
  onAlign,
  canAlign,
  onDeleteTrack,
  onRenameTrack,
  onRenameClip,
  onRenameMarker,
  onMarkersChange,
  onDeleteMarker,
  onClipAction,
  canPaste,
  onZoom,
  onPxPerSecChange,
  onHoverTime
}: TimelineProps): React.JSX.Element {
  const zoom = zoomSlider(minPxPerSec, MAX_PX_PER_SEC)
  const drag = useRef<Drag | null>(null)
  // Snap on: clip move/trim locks onto other clips' edges.
  const [snap, setSnap] = useState(false)
  // Vertical move preview: the clips stay in their DOM parents during the
  // drag (re-parenting would kill pointer capture), shifted with translateY.
  const [dragRow, setDragRow] = useState<{ clipIds: number[]; delta: number } | null>(null)
  const [renaming, setRenaming] = useState<{
    kind: 'track' | 'clip' | 'marker'
    id: number
  } | null>(null)
  // Right-click menu; the snapshot of the clip drives item labels/enabling.
  const [menu, setMenu] = useState<{ x: number; y: number; clip: ClipInst } | null>(null)
  const [markerMenu, setMarkerMenu] = useState<{ x: number; y: number; id: number } | null>(null)
  const markerDrag = useRef<{
    id: number
    startX: number
    origTime: number
    moved: boolean
  } | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  // Visible scroll range: ruler marks render only for it, so a huge duration
  // never turns into millions of mark divs.
  const [scrollX, setScrollX] = useState(0)
  const { w: viewW } = useElementSize(scrollRef)
  // Time + viewport x under the cursor at pinch start; scroll is restored
  // after the zoomed width renders so that point stays put.
  const pinchAnchor = useRef<{ t: number; viewX: number } | null>(null)

  // Marquee: drag on empty timeline space rubber-bands a clip selection.
  // A plain click (< 3px) deselects and seeks, like before.
  const marquee = useRef<{ x0: number; y0: number; base: number[]; moved: boolean } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)

  /** Pointer position in .tl-content coordinates (follows the scroll). */
  const contentPos = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = contentRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const end = Math.max(duration, contentEnd(tracks))

  /** Seek clamped to the timeline: the tail pad is visual, not seekable. */
  const clampSeek = (sec: number): void => onSeek(Math.min(Math.max(sec, 0), end))

  const onBgPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const pos = contentPos(e)
    marquee.current = {
      x0: pos.x,
      y0: pos.y,
      base: e.shiftKey || e.metaKey || e.ctrlKey ? selectedIds : [],
      moved: false
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onBgPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const m = marquee.current
    if (!m) return
    const pos = contentPos(e)
    if (!m.moved && Math.abs(pos.x - m.x0) < 3 && Math.abs(pos.y - m.y0) < 3) return
    m.moved = true
    const rect = {
      x: Math.min(m.x0, pos.x),
      y: Math.min(m.y0, pos.y),
      w: Math.abs(pos.x - m.x0),
      h: Math.abs(pos.y - m.y0)
    }
    setMarqueeRect(rect)
    const hits = [...m.base]
    tracks.forEach((track, trackIdx) => {
      const top = RULER_H + trackIdx * TRACK_HEIGHT
      if (top + TRACK_HEIGHT < rect.y || top > rect.y + rect.h) return
      for (const c of track.clips) {
        const left = LABEL_W + c.offset * pxPerSec
        const width = Math.max(clipLen(c) * pxPerSec, 12)
        if (left + width < rect.x || left > rect.x + rect.w) continue
        if (!hits.includes(c.id)) hits.push(c.id)
      }
    })
    onSelectMany(hits)
  }

  const onBgPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const m = marquee.current
    marquee.current = null
    setMarqueeRect(null)
    if (!m || m.moved) return
    // Plain click on empty space: deselect, and seek when it lands in a lane.
    onSelect(null)
    const pos = contentPos(e)
    const inLanes = pos.y >= RULER_H && pos.y < RULER_H + tracks.length * TRACK_HEIGHT
    if (inLanes && pos.x >= LABEL_W) clampSeek((pos.x - LABEL_W) / pxPerSec)
  }

  // Marquee selection is applied per-move, so cancel just drops the rect.
  const onBgPointerCancel = (): void => {
    marquee.current = null
    setMarqueeRect(null)
  }

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
      // The zoom clamp lives in the parent: a pinch at the range edge
      // commits nothing, so the layout effect never consumes this anchor.
      // Drop it at the frame boundary (a consuming commit flushes first) so
      // a later zoom button press can't apply a stale anchor and jump the
      // scroll.
      requestAnimationFrame(() => {
        pinchAnchor.current = null
      })
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

  /** Smallest correction that lands t on another clip's edge, or 0. */
  const snapAdjust = (t: number, excludeIds: Set<number>): number => {
    if (!snap) return 0
    let best = 0
    let bestAbs = SNAP_PX / pxPerSec
    for (const track of tracks) {
      for (const c of track.clips) {
        if (excludeIds.has(c.id)) continue
        for (const edge of [c.offset, c.offset + clipLen(c)]) {
          const diff = edge - t
          if (Math.abs(diff) <= bestAbs) {
            bestAbs = Math.abs(diff)
            best = diff
          }
        }
      }
    }
    return best
  }

  const applyDrag = (e: React.PointerEvent, commit: boolean): void => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.startX) / pxPerSec
    const dy = e.clientY - d.startY
    const orig = d.orig

    if (d.mode === 'move') {
      // The whole selection moves together: dx clamps so the earliest clip
      // stays at 0+, the row delta so every clip stays on an existing track.
      const minOffset = Math.min(...d.origs.map((o) => o.clip.offset))
      let dxc = Math.max(dx, -minOffset)
      // Snap the grabbed clip's edges to other clips' edges.
      const ids = new Set(d.origs.map((o) => o.clip.id))
      const startAdj = snapAdjust(orig.offset + dxc, ids)
      const endAdj = snapAdjust(orig.offset + clipLen(orig) + dxc, ids)
      const adj =
        startAdj !== 0 && (endAdj === 0 || Math.abs(startAdj) <= Math.abs(endAdj))
          ? startAdj
          : endAdj
      dxc = Math.max(dxc + adj, -minOffset)
      const minTrack = Math.min(...d.origs.map((o) => o.trackIdx))
      const maxTrack = Math.max(...d.origs.map((o) => o.trackIdx))
      const rowDelta = Math.min(
        Math.max(Math.round(dy / TRACK_HEIGHT), -minTrack),
        tracks.length - 1 - maxTrack
      )
      setDragRow(commit ? null : { clipIds: d.origs.map((o) => o.clip.id), delta: rowDelta })
      // Re-parent to the target tracks only on commit.
      const next = tracks.map((track, i) => {
        const without = track.clips.filter((c) => !ids.has(c.id))
        const moved = d.origs
          .filter((o) => o.trackIdx + (commit ? rowDelta : 0) === i)
          .map((o) => ({ ...o.clip, offset: o.clip.offset + dxc }))
        return { ...track, clips: [...without, ...moved] }
      })
      onTracksChange(next, commit)
      return
    }

    const updated: ClipInst = { ...orig }
    const self = new Set([d.clipId])
    if (d.mode === 'trim-in') {
      const lo = -Math.min(orig.trimIn, orig.offset)
      const hi = clipLen(orig) - MIN_CLIP_LEN
      let delta = Math.min(Math.max(dx, lo), hi)
      delta = Math.min(Math.max(delta + snapAdjust(orig.offset + delta, self), lo), hi)
      updated.trimIn = orig.trimIn + delta
      updated.offset = orig.offset + delta
    }
    if (d.mode === 'trim-out') {
      const lo = orig.trimIn + MIN_CLIP_LEN
      const hi = orig.summary.duration
      let out = Math.min(Math.max(orig.trimOut + dx, lo), hi)
      // The clip's right edge sits at offset + (trimOut - trimIn).
      out = Math.min(Math.max(out + snapAdjust(orig.offset + (out - orig.trimIn), self), lo), hi)
      updated.trimOut = out
    }

    const next = tracks.map((track) => ({
      ...track,
      clips: track.clips.map((c) => (c.id === d.clipId ? updated : c))
    }))
    onTracksChange(next, commit)
  }

  const onClipPointerDown = (e: React.PointerEvent<HTMLDivElement>, clip: ClipInst): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    // Shift/cmd-click toggles selection membership; no drag starts.
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      onSelect(clip.id, true)
      return
    }
    const wasSelected = selectedIds.includes(clip.id)
    if (!wasSelected) onSelect(clip.id)
    // Grabbing a selected clip drags the whole selection.
    const groupIds = wasSelected ? selectedIds : [clip.id]
    const origs = tracks.flatMap((t, i) =>
      t.clips.filter((c) => groupIds.includes(c.id)).map((c) => ({ clip: c, trackIdx: i }))
    )
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const mode: DragMode =
      x < TRIM_HANDLE_PX ? 'trim-in' : x > rect.width - TRIM_HANDLE_PX ? 'trim-out' : 'move'
    drag.current = {
      mode,
      clipId: clip.id,
      startX: e.clientX,
      startY: e.clientY,
      orig: clip,
      origs,
      wasSelected,
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
    // A plain click on an already-selected clip collapses the selection to it.
    else if (d.wasSelected) onSelect(d.clipId)
    drag.current = null
    setDragRow(null)
  }

  // Cancel coords are unreliable, so abort instead of committing there.
  const onClipPointerCancel = (): void => {
    const d = drag.current
    drag.current = null
    setDragRow(null)
    if (d?.moved) onDragCancel()
  }

  const applyMarkerDrag = (e: React.PointerEvent, commit: boolean): void => {
    const d = markerDrag.current
    if (!d) return
    // Clamp to the timeline so the marker can't push the playhead past end.
    const time = Math.min(Math.max(d.origTime + (e.clientX - d.startX) / pxPerSec, 0), end)
    onMarkersChange(
      markers.map((m) => (m.id === d.id ? { ...m, time } : m)),
      commit
    )
    // The playhead tracks the marker's own time, not the cursor (the grab
    // point sits somewhere inside the flag).
    clampSeek(time)
  }

  useEffect(() => {
    if (!menu && !markerMenu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setMenu(null)
      setMarkerMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, markerMenu])

  const menuAction = (action: ClipAction): void => {
    if (menu) onClipAction(action, menu.clip.id)
    setMenu(null)
  }

  const widthPx = Math.max(end * pxPerSec + TAIL_PAD, 600)
  const step = rulerStep(pxPerSec)
  const marks: number[] = []
  // Marks stop at the timeline end (the tail pad shows no times). A mark's
  // label sticks out ~80px right of its tick; skip marks whose label would
  // poke past the content edge and stretch scrollWidth (the full timeline
  // must fit the viewport at min zoom). Only the visible scroll range gets
  // marks; the loop is bounded by the viewport, never by `end`.
  const visT0 = Math.max(0, (scrollX - LABEL_W) / pxPerSec)
  const visT1 = (scrollX + (viewW || 1600)) / pxPerSec
  for (let i = Math.floor(visT0 / step); ; i++) {
    const s = i * step
    if (s > end || s > visT1 || s * pxPerSec + 80 > widthPx) break
    marks.push(Math.round(s * 1e6) / 1e6)
  }

  return (
    <div className="timeline-panel">
      <div className="tl-header">
        <button
          className="btn small"
          data-tip="Add Marker"
          aria-label="add marker"
          onClick={onAddMarker}
        >
          <BookmarkPlus size={14} />
        </button>
        <button
          className={snap ? 'btn small snap active' : 'btn small snap'}
          data-tip="Snap"
          aria-label="snap"
          aria-pressed={snap}
          onClick={() => setSnap((s) => !s)}
        >
          <Magnet size={14} />
        </button>
        <button
          className="btn small"
          onClick={onAlign}
          disabled={!canAlign}
          data-tip="Align with clock"
          aria-label="align clips"
        >
          <AlignStartVertical size={14} />
        </button>
        <div className="spacer" />
        <button
          className="btn small"
          onClick={() => onZoom(1 / 1.5)}
          data-tip="zoom out"
          aria-label="zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <input
          className="zoom-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={zoom.toSlider(pxPerSec)}
          style={{ '--val': `${zoom.toSlider(pxPerSec)}%` } as React.CSSProperties}
          aria-label="zoom"
          onChange={(e) => onPxPerSecChange(zoom.fromSlider(Number(e.target.value)))}
        />
        <button
          className="btn small"
          onClick={() => onZoom(1.5)}
          data-tip="zoom in"
          aria-label="zoom in"
        >
          <ZoomIn size={14} />
        </button>
      </div>
      <div
        className="timeline-scroll"
        ref={scrollRef}
        onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}
        onPointerDown={onBgPointerDown}
        onPointerMove={(e) => {
          onBgPointerMove(e)
          const x = contentPos(e).x
          onHoverTime?.(x >= LABEL_W ? Math.min(Math.max((x - LABEL_W) / pxPerSec, 0), end) : null)
        }}
        onPointerUp={onBgPointerUp}
        onPointerCancel={onBgPointerCancel}
        onPointerLeave={() => onHoverTime?.(null)}
      >
        <div className="tl-content" ref={contentRef} style={{ width: widthPx + 96 }}>
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
                clampSeek((e.clientX - rect.left) / pxPerSec)
              }}
              onPointerMove={(e) => {
                if ((e.buttons & 1) === 0) return
                const rect = e.currentTarget.getBoundingClientRect()
                clampSeek((e.clientX - rect.left) / pxPerSec)
              }}
            >
              {marks.map((s) => (
                <div key={s} className="ruler-mark" style={{ left: s * pxPerSec }}>
                  {formatRulerLabel(s, step)}
                </div>
              ))}
              {markers.map((m, i) => (
                <div
                  key={m.id}
                  className="marker-flag"
                  style={{ left: m.time * pxPerSec }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    if (e.button !== 0) return
                    markerDrag.current = {
                      id: m.id,
                      startX: e.clientX,
                      origTime: m.time,
                      moved: false
                    }
                    e.currentTarget.setPointerCapture(e.pointerId)
                  }}
                  onPointerMove={(e) => {
                    // Don't bubble to the ruler: its scrub-seek follows the
                    // cursor, which is offset from the marker time.
                    e.stopPropagation()
                    const d = markerDrag.current
                    if (!d) return
                    if (!d.moved && Math.abs(e.clientX - d.startX) < 3) return
                    d.moved = true
                    applyMarkerDrag(e, false)
                  }}
                  onPointerUp={(e) => {
                    const d = markerDrag.current
                    if (!d) return
                    if (d.moved) applyMarkerDrag(e, true)
                    markerDrag.current = null
                  }}
                  onPointerCancel={() => {
                    const d = markerDrag.current
                    markerDrag.current = null
                    if (d?.moved) onDragCancel()
                  }}
                  // Pointer capture (drag) retargets the dblclick from the
                  // label span to this div, so the rename trigger lives here.
                  onDoubleClick={() => setRenaming({ kind: 'marker', id: m.id })}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setMarkerMenu({ x: e.clientX, y: e.clientY, id: m.id })
                  }}
                >
                  <EditableLabel
                    value={m.label}
                    placeholder={`M${i + 1}`}
                    ariaLabel={`rename marker ${i + 1}`}
                    editing={renaming?.kind === 'marker' && renaming.id === m.id}
                    onEditStart={() => setRenaming({ kind: 'marker', id: m.id })}
                    onEditEnd={() => setRenaming(null)}
                    onRename={(label) => onRenameMarker(m.id, label)}
                  />
                </div>
              ))}
            </div>
          </div>

          {markers.map((m) => (
            <div key={m.id} className="marker-line" style={{ left: LABEL_W + m.time * pxPerSec }} />
          ))}

          <PlayheadLine playhead={playhead} playing={playing} pxPerSec={pxPerSec} />

          {tracks.map((track, trackIdx) => (
            <div className="track" key={track.id} style={{ height: TRACK_HEIGHT }}>
              <div
                className={'track-label' + (selectedTrackIds.includes(track.id) ? ' selected' : '')}
                // Keep the scroll area's deselect-on-pointerdown away so an
                // additive click doesn't clear the selection first.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => onSelectTrack(track.id, e.shiftKey || e.metaKey || e.ctrlKey)}
              >
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
                  data-tip="delete track"
                  aria-label={`delete track ${trackIdx + 1}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteTrack(track.id)
                  }}
                >
                  ×
                </button>
              </div>
              {/* Empty-lane pointerdowns bubble to the scroll area: a drag
                  marquee-selects, a plain click seeks on pointer-up. */}
              <div className="track-lane" style={{ width: widthPx }}>
                {track.clips.map((clip) => {
                  const warning = clip.missing
                    ? null
                    : recordingWarning(
                        clip.summary.dropped,
                        clip.summary.writeErrors,
                        clip.summary.writeError
                      )
                  return (
                    <div
                      key={clip.id}
                      data-tip={warning ?? undefined}
                      className={
                        'clip' +
                        (selectedIds.includes(clip.id) ? ' selected' : '') +
                        (clip.muted ? ' muted' : '') +
                        (clip.missing ? ' missing' : '') +
                        (warning != null ? ' warn' : '')
                      }
                      style={{
                        left: clip.offset * pxPerSec,
                        width: Math.max(clipLen(clip) * pxPerSec, 12),
                        ...(dragRow?.clipIds.includes(clip.id) && {
                          transform: `translateY(${dragRow.delta * TRACK_HEIGHT}px)`,
                          zIndex: 10
                        })
                      }}
                      onPointerDown={(e) => onClipPointerDown(e, clip)}
                      onPointerMove={onClipPointerMove}
                      onPointerUp={onClipPointerUp}
                      onPointerCancel={onClipPointerCancel}
                      // Pointer capture retargets the dblclick from the label
                      // span to this div, so the rename trigger lives here.
                      onDoubleClick={() => setRenaming({ kind: 'clip', id: clip.id })}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        // Keep a multi-selection: the menu acts on it.
                        if (!selectedIds.includes(clip.id)) onSelect(clip.id)
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
                        {clip.missing
                          ? 'missing file'
                          : `${clipLen(clip).toFixed(1)}s · ${clip.summary.events} ev`}
                        {clip.summary.tlOffset != null && ' · tl'}
                        {warning != null && <span className="clip-warn"> ⚠</span>}
                      </span>
                      <div className="trim-handle trim-in" />
                      <div className="trim-handle trim-out" />
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          {recordingRow && (
            <div className="track" style={{ height: TRACK_HEIGHT }}>
              <div className="track-label">Track {tracks.length + 1}</div>
              <div className="track-lane" style={{ width: widthPx }}>
                <div
                  className={'clip recording' + (recordingRow.warning != null ? ' warn' : '')}
                  data-tip={recordingRow.warning ?? undefined}
                  style={{ left: 0, width: 160 }}
                >
                  <span className="clip-name">recording…</span>
                  <span className="clip-meta">
                    {recordingRow.events} ev
                    {recordingRow.warning != null && <span className="clip-warn"> ⚠</span>}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="add-track">
            <button
              className="btn small"
              data-tip="Add Track"
              aria-label="add track"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onAddTrack}
            >
              +
            </button>
          </div>

          {tracks.length === 0 && !recordingRow && (
            <div className="empty">No clips. Hit ● Rec to record incoming OSC.</div>
          )}

          {marqueeRect && (
            <div
              className="tl-marquee"
              style={{
                left: marqueeRect.x,
                top: marqueeRect.y,
                width: marqueeRect.w,
                height: marqueeRect.h
              }}
            />
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
              <button role="menuitem" onClick={() => menuAction('reveal')}>
                Reveal in Finder
              </button>
            </div>
          </div>
        )}

        {markerMenu && (
          <div
            className="ctx-overlay"
            onPointerDown={(e) => {
              e.stopPropagation()
              setMarkerMenu(null)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMarkerMenu(null)
            }}
          >
            <div
              className="ctx-menu"
              role="menu"
              style={{ left: markerMenu.x, top: markerMenu.y }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                role="menuitem"
                onClick={() => {
                  onDeleteMarker(markerMenu.id)
                  setMarkerMenu(null)
                }}
              >
                Delete marker
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
