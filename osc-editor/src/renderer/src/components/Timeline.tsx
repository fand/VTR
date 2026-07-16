import React, { useEffect, useRef, useState } from 'react'
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

interface Drag {
  mode: DragMode
  clipId: number
  fromTrack: number
  startX: number
  startY: number
  orig: ClipInst
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
}

const LABEL_W = 96

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
  onTracksChange
}: TimelineProps): React.JSX.Element {
  const drag = useRef<Drag | null>(null)
  // Vertical move preview: the clip stays in its DOM parent during the drag
  // (re-parenting would kill pointer capture) and is shifted with translateY.
  const [dragRow, setDragRow] = useState<{ clipId: number; delta: number } | null>(null)

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
      orig: clip
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onClipPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current) applyDrag(e, false)
  }

  const onClipPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    applyDrag(e, true)
    drag.current = null
    setDragRow(null)
  }

  const end = Math.max(duration, contentEnd(tracks))
  const widthPx = Math.max(end * pxPerSec, 600)
  const step = rulerStep(pxPerSec)
  const marks: number[] = []
  for (let s = 0; s <= end; s += step) marks.push(Math.round(s * 1e6) / 1e6)

  return (
    <div className="timeline-scroll" onPointerDown={() => onSelect(null)}>
      <div className="tl-content" style={{ width: widthPx + 96 }}>
        <div className="ruler-row">
          <div className="track-label ruler-corner" />
          <div
            className="ruler"
            style={{ width: widthPx }}
            onPointerDown={(e) => {
              e.stopPropagation()
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
            <div className="track-label">Track {trackIdx + 1}</div>
            <div
              className="track-lane"
              style={{ width: widthPx }}
              onPointerDown={(e) => {
                // Clip drags call stopPropagation, so this is an empty-lane click.
                const rect = e.currentTarget.getBoundingClientRect()
                onSeek(Math.max(0, (e.clientX - rect.left) / pxPerSec))
              }}
            >
              {track.clips.map((clip) => (
                <div
                  key={clip.id}
                  className={clip.id === selectedId ? 'clip selected' : 'clip'}
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
                >
                  <span className="clip-name">{clip.file}</span>
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

        {tracks.length === 0 && !recordingRow && (
          <div className="empty">No clips. Hit ● Rec to record incoming OSC.</div>
        )}
      </div>
    </div>
  )
}
