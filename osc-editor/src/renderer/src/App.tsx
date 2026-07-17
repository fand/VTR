import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_DURATION,
  DEFAULT_PORTS,
  type PortConfig,
  type TapStatus
} from '../../shared/types'
import { CurvePanel, PointPatch, PointSel } from './components/CurvePanel'
import {
  ClipAction,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  PlayingState,
  Timeline
} from './components/Timeline'
import { evalExpr } from './expr'
import { Doc, useHistory } from './history'
import {
  ClipInst,
  MIN_CLIP_LEN,
  MarkerState,
  TrackState,
  alignClip,
  clipLen,
  markersFromProject,
  serializeProject,
  tracksFromProject
} from './timeline/model'

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

function formatTimecode(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor(s / 60) % 60
  const sec = Math.floor(s) % 60
  const ms = Math.floor(s * 1000) % 1000
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)}.${pad(ms, 3)}`
}

function Timecode({
  recStartedAt,
  playing,
  playhead
}: {
  recStartedAt: number | null
  playing: PlayingState | null
  playhead: number
}): React.JSX.Element {
  const [now, setNow] = useState(0)
  const animating = recStartedAt != null || playing != null
  useEffect(() => {
    if (!animating) {
      setNow(0)
      return
    }
    let raf: number
    const tick = (): void => {
      setNow(performance.now())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [animating])
  let secs = playhead
  if (recStartedAt != null) secs = (now - recStartedAt) / 1000
  else if (playing != null) {
    secs = Math.min(playing.startPos + (now - playing.startedAt) / 1000, playing.duration)
  }
  return (
    <div className={recStartedAt != null ? 'timecode rec' : 'timecode'}>
      {formatTimecode(Math.max(0, secs))}
    </div>
  )
}

function NumField({
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

/** True when a keyboard event comes from a text field; global shortcuts must ignore it. */
function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function parsePort(draft: string): number | null {
  const n = parseInt(draft, 10)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

/** Accepts arithmetic ("60*2" → 120); must come out positive. */
function parseDuration(draft: string): number | null {
  const n = evalExpr(draft)
  return n != null && n > 0 ? n : null
}

function App(): React.JSX.Element {
  const [recording, setRecording] = useState<{ path: string; startedAt: number } | null>(null)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [selectedTrackIds, setSelectedTrackIds] = useState<number[]>([])
  const [selectedPoints, setSelectedPoints] = useState<PointSel[]>([])
  const [pxPerSec, setPxPerSec] = useState(20)
  const [curveHeight, setCurveHeight] = useState(220)
  const splitDrag = useRef<{ y: number; h: number } | null>(null)
  const [status, setStatus] = useState<TapStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState<PlayingState | null>(null)
  const [ports, setPorts] = useState<PortConfig>(DEFAULT_PORTS)
  const nextId = useRef(1)
  const [loaded, setLoaded] = useState(false)
  const newId = useCallback((): number => nextId.current++, [])

  // Undo/redo can reinstall ids from an earlier session; keep the counter
  // ahead of them and drop selections that no longer resolve.
  const onRestore = useCallback((doc: Doc): void => {
    let max = 0
    for (const t of doc.tracks) {
      max = Math.max(max, t.id)
      for (const c of t.clips) max = Math.max(max, c.id)
    }
    for (const m of doc.markers) max = Math.max(max, m.id)
    nextId.current = Math.max(nextId.current, max + 1)
    setSelectedIds((ids) =>
      ids.filter((id) => doc.tracks.some((t) => t.clips.some((c) => c.id === id)))
    )
    setSelectedTrackIds((ids) => ids.filter((id) => doc.tracks.some((t) => t.id === id)))
    setSelectedPoints([])
  }, [])

  const history = useHistory(
    { tracks: [], markers: [], duration: DEFAULT_DURATION, edits: {} },
    onRestore
  )
  const { reset, transient, commit, undo, redo } = history
  const { tracks, markers, duration, edits } = history.doc

  // Load project.json and the undo log once at boot.
  useEffect(() => {
    Promise.all([window.api.project.load(), window.api.undo.load()])
      .then(([project, log]) => {
        let doc: Doc = { tracks: [], markers: [], duration: DEFAULT_DURATION, edits: {} }
        if (project) {
          doc = {
            tracks: tracksFromProject(project, newId),
            markers: markersFromProject(project, newId),
            duration: project.duration ?? DEFAULT_DURATION,
            edits: project.edits
          }
          if (project.ports) {
            // Older project.json may lack the beacon port.
            const loadedPorts = { ...DEFAULT_PORTS, ...project.ports }
            setPorts(loadedPorts)
            window.api.tap.setPorts(loadedPorts).catch((e: Error) => setError(e.message))
          }
          if (project.missing.length > 0) {
            setError(`missing clip files: ${project.missing.join(', ')}`)
          }
        }
        // undoSeq is the cursor: entries at or below it are undoable from the
        // saved state, later ones are redo (incl. crash-recovery tails).
        const cursor = project?.undoSeq ?? Math.max(0, ...log.map((e) => e.seq))
        reset(
          doc,
          log.filter((e) => e.seq <= cursor),
          log.filter((e) => e.seq > cursor)
        )
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setLoaded(true)
      })
  }, [newId, reset])

  // Autosave (debounced), but never before the initial load finished.
  // `loaded` is state (not a ref) so an edit made during the load still
  // gets saved once the load completes.
  useEffect(() => {
    if (!loaded) return
    const timer = setTimeout(() => {
      window.api.project
        .save(serializeProject(tracks, markers, ports, duration, edits, history.seq))
        .catch((e: Error) => setError(e.message))
    }, 400)
    return () => clearTimeout(timer)
  }, [loaded, tracks, markers, ports, duration, edits, history.seq])

  const changePorts = useCallback((next: PortConfig) => {
    setPorts(next)
    window.api.tap.setPorts(next).catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    const poll = (): void => {
      window.api.tap
        .status()
        .then((s) => {
          setStatus(s)
          setStatusError(null)
        })
        .catch((e: Error) => setStatusError(e.message))
    }
    poll()
    const iv = setInterval(poll, 1000)
    return () => clearInterval(iv)
  }, [])

  const toggleRecord = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      if (recording) {
        const summary = await window.api.tap.stop(recording.path)
        const track: TrackState = {
          id: newId(),
          clips: [
            alignClip({
              id: newId(),
              file: summary.name,
              path: summary.path,
              offset: 0,
              trimIn: 0,
              trimOut: Math.max(summary.duration, 0.1),
              summary
            })
          ]
        }
        commit('record clip', (d) => {
          d.tracks.push(track)
        })
        setRecording(null)
      } else {
        const path = await window.api.tap.start()
        setRecording({ path, startedAt: performance.now() })
      }
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [recording, busy, newId])

  // Tracks live independently of clips: emptying one no longer removes it.
  // Drags stream transient docs and commit once on release (one undo entry).
  const onTracksChange = useCallback(
    (next: TrackState[], isCommit: boolean) => {
      if (isCommit) {
        commit('edit clips', (d) => {
          d.tracks = next
        })
      } else {
        transient((d) => {
          d.tracks = next
        })
      }
    },
    [commit, transient]
  )

  const addTrack = useCallback(() => {
    const id = newId()
    commit('add track', (d) => {
      d.tracks.push({ id, clips: [] })
    })
  }, [commit, newId])

  const addMarker = useCallback(() => {
    const id = newId()
    commit('add marker', (d) => {
      d.markers.push({ id, time: playhead })
    })
  }, [commit, newId, playhead])

  const renameMarker = useCallback(
    (markerId: number, label: string) => {
      commit('rename marker', (d) => {
        const m = d.markers.find((m) => m.id === markerId)
        if (!m) return
        if (label) m.label = label
        else delete m.label
      })
    },
    [commit]
  )

  // Marker drags stream transient docs and commit once on release.
  const onMarkersChange = useCallback(
    (next: MarkerState[], isCommit: boolean) => {
      if (isCommit) {
        commit('move marker', (d) => {
          d.markers = next
        })
      } else {
        transient((d) => {
          d.markers = next
        })
      }
    },
    [commit, transient]
  )

  const deleteMarker = useCallback(
    (markerId: number) => {
      commit('delete marker', (d) => {
        d.markers = d.markers.filter((m) => m.id !== markerId)
      })
    },
    [commit]
  )

  const deleteTrack = useCallback(
    (trackId: number) => {
      commit('delete track', (d) => {
        d.tracks = d.tracks.filter((t) => t.id !== trackId)
      })
      setSelectedIds([])
      setSelectedTrackIds((ids) => ids.filter((id) => id !== trackId))
      setSelectedPoints([])
    },
    [commit]
  )

  const renameTrack = useCallback(
    (trackId: number, name: string) => {
      commit('rename track', (d) => {
        const t = d.tracks.find((t) => t.id === trackId)
        if (!t) return
        if (name) t.name = name
        else delete t.name
      })
    },
    [commit]
  )

  const renameClip = useCallback(
    (clipId: number, name: string) => {
      commit('rename clip', (d) => {
        for (const t of d.tracks) {
          const c = t.clips.find((c) => c.id === clipId)
          if (c) {
            if (name) c.name = name
            else delete c.name
            return
          }
        }
      })
    },
    [commit]
  )

  // Clip clipboard (session-local, not the OS clipboard). Paste overrides
  // id/offset, so storing stale ids is harmless; the source track ids are
  // the paste targets when no other track is implied.
  const clipClipboard = useRef<{ clip: ClipInst; trackId: number }[]>([])
  const [canPaste, setCanPaste] = useState(false)

  const copyClips = useCallback(
    (clipIds: number[]) => {
      const items = tracks.flatMap((t) =>
        t.clips.filter((c) => clipIds.includes(c.id)).map((clip) => ({ clip, trackId: t.id }))
      )
      if (items.length === 0) return
      clipClipboard.current = items
      setCanPaste(true)
    },
    [tracks]
  )

  /**
   * Paste at the playhead, keeping relative offsets (the earliest clip lands
   * on the playhead). A single clip goes onto targetTrackId ?? its source
   * track; a multi-clip paste always keeps source tracks.
   */
  const pasteClips = useCallback(
    (targetTrackId?: number) => {
      const items = clipClipboard.current
      if (items.length === 0) return
      const base = Math.min(...items.map((it) => it.clip.offset))
      const ids = items.map(() => newId())
      commit('paste clip', (d) => {
        items.forEach((it, i) => {
          const t =
            (items.length === 1 ? d.tracks.find((t) => t.id === targetTrackId) : undefined) ??
            d.tracks.find((t) => t.id === it.trackId) ??
            d.tracks[0]
          t?.clips.push({ ...it.clip, id: ids[i], offset: playhead + it.clip.offset - base })
        })
      })
      setSelectedIds(ids)
    },
    [commit, newId, playhead]
  )

  /** Duplicate clips in place, each right after its original. */
  const duplicateClips = useCallback(
    (clipIds: number[]) => {
      const pairs = clipIds.map((id) => ({ id, dupId: newId() }))
      commit('duplicate clip', (d) => {
        for (const { id, dupId } of pairs) {
          const t = d.tracks.find((t) => t.clips.some((c) => c.id === id))
          const c = t?.clips.find((c) => c.id === id)
          if (!t || !c) continue
          t.clips.push({ ...c, id: dupId, offset: c.offset + clipLen(c) })
        }
      })
      setSelectedIds(pairs.map((p) => p.dupId))
    },
    [commit, newId]
  )

  const onClipAction = useCallback(
    (action: ClipAction, clipId: number) => {
      const clip = tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
      if (!clip) return
      // A right-click inside a multi-selection acts on the whole selection.
      const targetIds = selectedIds.includes(clipId) ? selectedIds : [clipId]
      const inDoc = (d: Doc): ClipInst | undefined =>
        d.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
      switch (action) {
        case 'mute':
          commit(clip.muted ? 'unmute clip' : 'mute clip', (d) => {
            for (const t of d.tracks) {
              for (const c of t.clips) {
                if (!targetIds.includes(c.id)) continue
                if (clip.muted) delete c.muted
                else c.muted = true
              }
            }
          })
          break
        case 'copy':
          copyClips(targetIds)
          break
        case 'paste': {
          // Paste onto the right-clicked clip's track.
          pasteClips(tracks.find((t) => t.clips.some((c) => c.id === clipId))?.id)
          break
        }
        case 'duplicate':
          duplicateClips(targetIds)
          break
        case 'split': {
          // Cut point in clip-local seconds; both halves keep a playable length.
          const local = clip.trimIn + (playhead - clip.offset)
          if (local < clip.trimIn + MIN_CLIP_LEN || local > clip.trimOut - MIN_CLIP_LEN) return
          const id = newId()
          commit('split clip', (d) => {
            const c = inDoc(d)
            if (!c) return
            const t = d.tracks.find((t) => t.clips.some((c) => c.id === clipId))
            t?.clips.push({ ...c, id, offset: playhead, trimIn: local })
            c.trimOut = local
          })
          break
        }
      }
    },
    [tracks, selectedIds, playhead, commit, newId, copyClips, pasteClips, duplicateClips]
  )

  // Cmd+C/Cmd+V on clips. The Edit menu handles the native text-field side
  // and notifies us; a keydown fallback covers synthetic input (e2e).
  const copySelected = useCallback(() => {
    if (selectedIds.length > 0) copyClips(selectedIds)
  }, [selectedIds, copyClips])

  const pasteAtPlayhead = useCallback(() => {
    pasteClips(tracks.find((t) => t.clips.some((c) => c.id === selectedIds[0]))?.id)
  }, [tracks, selectedIds, pasteClips])

  useEffect(() => {
    const offCopy = window.api.menu.on('copy', () => {
      if (!isTextInput(document.activeElement)) copySelected()
    })
    const offPaste = window.api.menu.on('paste', () => {
      if (!isTextInput(document.activeElement)) pasteAtPlayhead()
    })
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || isTextInput(e.target)) return
      const k = e.key.toLowerCase()
      if (k === 'c') copySelected()
      else if (k === 'v') pasteAtPlayhead()
      else if (k === 'd') {
        e.preventDefault()
        if (selectedIds.length > 0) duplicateClips(selectedIds)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offCopy()
      offPaste()
      window.removeEventListener('keydown', onKey)
    }
  }, [copySelected, pasteAtPlayhead, selectedIds, duplicateClips])

  // A curve point only makes sense within the clip it belongs to.
  // Additive select (shift/cmd-click) toggles membership.
  // Clip and track selections are mutually exclusive.
  const selectClip = useCallback((id: number | null, additive = false) => {
    setSelectedPoints([])
    setSelectedTrackIds([])
    if (id == null) {
      setSelectedIds([])
      return
    }
    setSelectedIds((ids) => {
      if (!additive) return [id]
      return ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]
    })
  }, [])

  const selectTrack = useCallback((id: number, additive: boolean) => {
    setSelectedPoints([])
    setSelectedIds([])
    setSelectedTrackIds((ids) => {
      if (!additive) return [id]
      return ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]
    })
  }, [])

  // The curve panel shows every selected clip's events; with no clip
  // selected, the selected tracks' clips.
  const selectedClips = React.useMemo(
    () => tracks.flatMap((t) => t.clips).filter((c) => selectedIds.includes(c.id)),
    [tracks, selectedIds]
  )
  const curveClips = React.useMemo(
    () =>
      selectedClips.length > 0
        ? selectedClips
        : tracks.filter((t) => selectedTrackIds.includes(t.id)).flatMap((t) => t.clips),
    [selectedClips, tracks, selectedTrackIds]
  )

  const onPointEdit = useCallback(
    (patches: PointPatch[], isCommit: boolean) => {
      if (patches.length === 0) return
      const apply = (d: Doc): void => {
        for (const patch of patches) {
          const clipEdits = (d.edits[patch.file] ??= {})
          const set = (clipEdits.set ??= {})
          const entry = (set[patch.eventIndex] ??= {})
          if (patch.t != null) entry.t = patch.t
          if (patch.argIndex != null && patch.value != null) {
            ;(entry.args ??= {})[patch.argIndex] = patch.value
          }
        }
      }
      if (isCommit) commit('edit points', apply)
      else transient(apply)
    },
    [commit, transient]
  )

  const deleteSelectedPoints = useCallback(() => {
    if (selectedPoints.length === 0) return
    commit('delete points', (d) => {
      for (const pt of selectedPoints) {
        const clipEdits = (d.edits[pt.file] ??= {})
        ;(clipEdits.del ??= {})[pt.eventIndex] = true
      }
    })
    setSelectedPoints([])
  }, [selectedPoints, commit])

  const stopPreview = useCallback(async () => {
    try {
      const { position } = await window.api.preview.stop()
      setPlayhead(position)
    } catch (e) {
      setError((e as Error).message)
    }
    setPlaying(null)
  }, [])

  const togglePlay = useCallback(async () => {
    if (playing) {
      await stopPreview()
      return
    }
    if (tracks.length === 0) return
    try {
      const res = await window.api.preview.play(
        serializeProject(tracks, markers, ports, duration, edits, history.seq),
        playhead
      )
      setPlaying({ startPos: playhead, startedAt: performance.now(), duration: res.duration })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [playing, tracks, markers, ports, duration, edits, playhead, stopPreview])

  // Auto-stop when the playhead reaches the end.
  useEffect(() => {
    if (!playing) return
    const remaining =
      (playing.duration - playing.startPos) * 1000 - (performance.now() - playing.startedAt)
    const timer = setTimeout(() => stopPreview(), Math.max(remaining, 0) + 100)
    return () => clearTimeout(timer)
  }, [playing, stopPreview])

  const onSeek = useCallback(
    (sec: number) => {
      if (playing) return
      setPlayhead(sec)
    },
    [playing]
  )

  const doExport = useCallback(async () => {
    try {
      const result = await window.api.session.export(
        serializeProject(tracks, markers, ports, duration, edits, history.seq)
      )
      if (!result) return // save dialog cancelled
      setInfo(`exported ${result.path} (${result.events} events, ${result.duration.toFixed(1)}s)`)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [tracks, markers, ports, duration, edits])

  // Info banner auto-hide.
  useEffect(() => {
    if (!info) return
    const timer = setTimeout(() => setInfo(null), 5000)
    return () => clearTimeout(timer)
  }, [info])

  // Space toggles preview unless recording or typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || recording || isTextInput(e.target)) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, recording])

  // M adds a marker at the playhead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'm' || e.metaKey || e.ctrlKey || e.altKey) return
      if (isTextInput(e.target)) return
      addMarker()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addMarker])

  const alignAll = useCallback(() => {
    commit('align clips', (d) => {
      for (const t of d.tracks) {
        for (const c of t.clips) c.offset = alignClip(c).offset
      }
    })
  }, [commit])

  // Delete selected curve point, else selected clip (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (isTextInput(e.target)) return
      if (selectedPoints.length > 0) {
        deleteSelectedPoints()
        return
      }
      if (selectedIds.length === 0) return
      commit('delete clip', (d) => {
        for (const t of d.tracks) t.clips = t.clips.filter((c) => !selectedIds.includes(c.id))
      })
      setSelectedIds([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, selectedPoints, deleteSelectedPoints, commit])

  // Undo/redo arrives two ways: the Edit menu (real usage — its accelerator
  // swallows the native Cmd+Z) and a keydown fallback (synthetic input, e.g.
  // e2e, never reaches menu accelerators). Exactly one path fires per press.
  useEffect(() => {
    const offUndo = window.api.menu.on('undo', () => {
      if (isTextInput(document.activeElement)) document.execCommand('undo')
      else undo()
    })
    const offRedo = window.api.menu.on('redo', () => {
      if (isTextInput(document.activeElement)) document.execCommand('redo')
      else redo()
    })
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || isTextInput(e.target)) return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offUndo()
      offRedo()
      window.removeEventListener('keydown', onKey)
    }
  }, [undo, redo])

  const zoom = useCallback((factor: number) => {
    setPxPerSec((z) => Math.min(Math.max(z * factor, MIN_PX_PER_SEC), MAX_PX_PER_SEC))
  }, [])

  const setZoom = useCallback((px: number) => {
    setPxPerSec(Math.min(Math.max(px, MIN_PX_PER_SEC), MAX_PX_PER_SEC))
  }, [])

  const hasTl = tracks.some((t) => t.clips.some((c) => c.summary.tlOffset != null))

  return (
    <div className="app">
      <header className="header">
        <span className="logo">osc-mtr</span>
        <Timecode
          recStartedAt={recording?.startedAt ?? null}
          playing={playing}
          playhead={playhead}
        />
        <button
          className={recording ? 'btn rec active' : 'btn rec'}
          onClick={toggleRecord}
          disabled={busy}
        >
          {recording ? '■ Stop' : '● Rec'}
        </button>
        <button
          className={playing ? 'btn play active' : 'btn play'}
          onClick={togglePlay}
          disabled={busy || !!recording || tracks.length === 0}
        >
          {playing ? '⏹ Stop' : '▶ Play'}
        </button>
        <button
          className="btn"
          onClick={alignAll}
          disabled={!hasTl}
          title="place clips at their TD timeline position (tl)"
        >
          Align
        </button>
        <div className="spacer" />
        <div className="ports-group">
          <NumField
            label="in"
            ariaLabel="in port"
            value={ports.listen}
            disabled={!!recording || !!playing}
            parse={parsePort}
            onCommit={(listen) => changePorts({ ...ports, listen })}
          />
          <NumField
            label="out"
            ariaLabel="out port"
            value={ports.forward}
            disabled={!!recording || !!playing}
            parse={parsePort}
            onCommit={(forward) => changePorts({ ...ports, forward })}
          />
          <NumField
            label="clock"
            ariaLabel="clock port"
            value={ports.beacon}
            disabled={!!recording || !!playing}
            parse={parsePort}
            onCommit={(beacon) => changePorts({ ...ports, beacon })}
          />
        </div>
        <button className="btn" onClick={doExport} disabled={tracks.length === 0 || !!recording}>
          Export
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {info && <div className="info-banner">{info}</div>}

      <Timeline
        tracks={tracks}
        markers={markers}
        pxPerSec={pxPerSec}
        duration={duration}
        selectedIds={selectedIds}
        selectedTrackIds={selectedTrackIds}
        recordingRow={recording ? { events: status?.events ?? 0 } : null}
        playhead={playhead}
        playing={playing}
        onSeek={onSeek}
        onSelect={selectClip}
        onSelectTrack={selectTrack}
        onTracksChange={onTracksChange}
        onAddTrack={addTrack}
        onAddMarker={addMarker}
        onDeleteTrack={deleteTrack}
        onRenameTrack={renameTrack}
        onRenameClip={renameClip}
        onRenameMarker={renameMarker}
        onMarkersChange={onMarkersChange}
        onDeleteMarker={deleteMarker}
        onClipAction={onClipAction}
        canPaste={canPaste}
        onZoom={zoom}
        onPxPerSecChange={setZoom}
      />

      <div
        className="panel-splitter"
        role="separator"
        aria-label="resize curve panel"
        onPointerDown={(e) => {
          splitDrag.current = { y: e.clientY, h: curveHeight }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = splitDrag.current
          if (!d) return
          const h = d.h + (d.y - e.clientY)
          setCurveHeight(Math.min(Math.max(h, 80), window.innerHeight - 240))
        }}
        onPointerUp={() => {
          splitDrag.current = null
        }}
      />

      <CurvePanel
        clips={curveClips}
        height={curveHeight}
        edits={edits}
        selectedPoints={selectedPoints}
        onSelectPoints={setSelectedPoints}
        onPointEdit={onPointEdit}
      />

      <div className="tl-toolbar">
        <NumField
          label="Timeline Duration"
          ariaLabel="timeline duration"
          value={duration}
          parse={parseDuration}
          onInput={(n) =>
            transient((d) => {
              d.duration = n
            })
          }
          onCommit={(n) =>
            commit('duration', (d) => {
              d.duration = n
            })
          }
          dragStep={1}
        />
        <span className="toolbar-unit">s</span>
      </div>

      <footer className="statusbar">
        <span className={statusError ? 'chip bad' : status ? 'chip ok' : 'chip'}>
          tap {statusError ? 'down' : status ? 'up' : '…'}
        </span>
        <span className={status?.beacon_tl != null ? 'chip ok' : 'chip'}>
          {status?.beacon_tl != null
            ? `clock tl=${status.beacon_tl.toFixed(2)}s` +
              (status.beacon_rate === 0
                ? ' (paused)'
                : status.beacon_rate != null && status.beacon_rate !== 1
                  ? ` ×${status.beacon_rate}`
                  : '') +
              ` (${status.beacon_age?.toFixed(1)}s ago)`
            : 'no clock'}
        </span>
        {status != null && status.dropped > 0 && (
          <span className="chip bad">dropped {status.dropped}</span>
        )}
      </footer>
    </div>
  )
}

export default App
