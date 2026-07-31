import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Circle, Pause, Play, Square } from 'lucide-react'
import {
  DEFAULT_DURATION,
  DEFAULT_PORTS,
  isValidEchoHost,
  type ClipCurve,
  type PortConfig
} from '../../shared/types'
import { CurvePanel, PointAdd, PointPatch } from './components/CurvePanel'
import { addPoints, applyPointPatches, deletePoints, replaceWithCurves } from '../../shared/edits'
import {
  ClipAction,
  LABEL_W,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  TAIL_PAD,
  Timeline
} from './components/Timeline'
import { FileMenu } from './components/FileMenu'
import { StatusBar } from './components/StatusBar'
import { Timecode } from './components/Timecode'
import { TooltipLayer } from './components/TooltipLayer'
import { NumField, TextField } from './components/fields'
import { parseDuration, parsePort } from './expr'
import { Doc, useHistory } from './history'
import { useProjectFile } from './useProjectFile'
import { useSelection } from './useSelection'
import { useTapStatus } from './useTapStatus'
import { useTransport } from './useTransport'
import { useShortcuts } from './useShortcuts'
import {
  ClipInst,
  MIN_CLIP_LEN,
  MarkerState,
  TrackState,
  alignClip,
  recordingWarning,
  clipLen,
  contentEnd,
  serializeProject
} from './timeline/model'

/** "3 clips", "1 point" — count + pluralized noun for log lines. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function App(): React.JSX.Element {
  const {
    clipIds: selectedIds,
    trackIds: selectedTrackIds,
    points: selectedPoints,
    setClipIds: setSelectedIds,
    setPoints: setSelectedPoints,
    selectClip,
    selectClips,
    selectTrack,
    clearAll: clearSelection,
    pruneToDoc: pruneSelection,
    trackDeleted: onTrackDeleted
  } = useSelection()
  const [pxPerSec, setPxPerSec] = useState(20)
  const [curveHeight, setCurveHeight] = useState(220)
  const splitDrag = useRef<{ y: number; h: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Latest event log line, shown at the right end of the status bar. */
  const [log, setLog] = useState<string | null>(null)
  const [ports, setPorts] = useState<PortConfig>(DEFAULT_PORTS)
  const nextId = useRef(1)
  const newId = useCallback((): number => nextId.current++, [])

  // Undo/redo can reinstall ids from an earlier session; keep the counter
  // ahead of them and drop selections that no longer resolve.
  const onRestore = useCallback(
    (doc: Doc): void => {
      let max = 0
      for (const t of doc.tracks) {
        max = Math.max(max, t.id)
        for (const c of t.clips) max = Math.max(max, c.id)
      }
      for (const m of doc.markers) max = Math.max(max, m.id)
      nextId.current = Math.max(nextId.current, max + 1)
      pruneSelection(doc)
    },
    [pruneSelection]
  )

  const onHistoryLog = useCallback((kind: 'commit' | 'undo' | 'redo', label: string): void => {
    setLog(kind === 'commit' ? label : `${kind === 'undo' ? 'Undo' : 'Redo'}: ${label}`)
  }, [])

  const history = useHistory(
    { tracks: [], markers: [], duration: DEFAULT_DURATION, edits: {} },
    onRestore,
    setError,
    onHistoryLog
  )
  const { reset, transient, commit, abortTransient, undo, redo } = history
  const { tracks, markers, duration, edits } = history.doc

  // Clip clipboard (session-local, not the OS clipboard). Paste overrides
  // id/offset, so storing stale ids is harmless; the source track ids are
  // the paste targets when no other track is implied.
  const clipClipboard = useRef<{ clip: ClipInst; trackId: number }[]>([])
  const [canPaste, setCanPaste] = useState(false)

  // Project switched: clipboard clips reference files in the previous
  // bundle; drop them.
  const onProjectSwitched = useCallback(() => {
    clipClipboard.current = []
    setCanPaste(false)
  }, [])

  const {
    projectFile,
    fileName,
    dirty,
    bootDone,
    saveProject,
    saveProjectAs,
    openProject,
    doExport
  } = useProjectFile({
    reset,
    doc: history.doc,
    seq: history.seq,
    ports,
    setPorts,
    newId,
    clearSelection,
    onProjectSwitched,
    setError,
    setLog
  })

  const serialize = useCallback(
    () => serializeProject(tracks, markers, ports, duration, edits, history.seq),
    [tracks, markers, ports, duration, edits, history.seq]
  )

  const { playhead, playing, togglePlay, onSeek } = useTransport({
    duration,
    hasTracks: tracks.length > 0,
    serialize,
    setError,
    setLog
  })

  // Session residency: keep the player holding the current merged project so
  // a TD-side scrub always resolves against something. Debounced after edits;
  // also fires once the boot load settles. An empty no-project state loads
  // nothing — it would clobber a session another client (the tox File
  // workflow) loaded, for no benefit.
  useEffect(() => {
    if (!bootDone || (!projectFile && tracks.length === 0)) return
    const t = setTimeout(() => {
      window.api.player.loadInline(serialize()).catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [bootDone, projectFile, tracks, serialize])

  // macOS layout: the header is the drag region and clears the traffic lights.
  useEffect(() => {
    document.body.classList.toggle('mac', window.api.platform === 'darwin')
  }, [])

  const changePorts = useCallback((next: PortConfig) => {
    setPorts(next)
    window.api.tap.setPorts(next).catch((e: Error) => setError(e.message))
  }, [])

  // Latest tracks for the import guard, without resubscribing per edit.
  const tracksRef = useRef(tracks)
  useEffect(() => {
    tracksRef.current = tracks
  }, [tracks])
  // Clips imported (or found referenced) this session, by file name: a reset
  // snapshot must not re-import a clip whose track the user deleted.
  const importedClips = useRef(new Set<string>())

  const maybeImportClip = useCallback(
    async (clipPath: string): Promise<void> => {
      const name = clipPath.split(/[\\/]/).pop() ?? clipPath
      if (importedClips.current.has(name)) return
      // By name, not path: save collects staging clips into the bundle, so a
      // track can reference this clip under a different path.
      if (tracksRef.current.some((t) => t.clips.some((c) => c.file === name))) {
        importedClips.current.add(name)
        return
      }
      // Mark before the await so a racing event/snapshot pair imports once.
      importedClips.current.add(name)
      try {
        const summary = await window.api.clip.summary(clipPath)
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
        commit(`Recorded ${summary.name} (${summary.duration.toFixed(1)}s)`, (d) => {
          d.tracks.push(track)
        })
      } catch (e) {
        // Collected into a bundle (staged source deleted) or otherwise gone:
        // nothing to import, not an error.
        console.warn(`clip import skipped: ${(e as Error).message}`)
      }
    },
    [commit, newId]
  )

  const importClip = useCallback((p: string) => void maybeImportClip(p), [maybeImportClip])
  const { status, statusError, playerStatus, rxRate, recording, busy, toggleRecord } = useTapStatus(
    { bootDone, importClip, setError, setLog }
  )

  // Tracks live independently of clips: emptying one no longer removes it.
  // Drags stream transient docs and commit once on release (one undo entry).
  const onTracksChange = useCallback(
    (next: TrackState[], isCommit: boolean) => {
      if (isCommit) {
        commit('Clips edited', (d) => {
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
    commit('Track added', (d) => {
      d.tracks.push({ id, clips: [] })
    })
  }, [commit, newId])

  const addMarker = useCallback(() => {
    const id = newId()
    commit('Marker added', (d) => {
      d.markers.push({ id, time: playhead })
    })
  }, [commit, newId, playhead])

  const renameMarker = useCallback(
    (markerId: number, label: string) => {
      commit('Marker renamed', (d) => {
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
        commit('Marker moved', (d) => {
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
      commit('Marker deleted', (d) => {
        d.markers = d.markers.filter((m) => m.id !== markerId)
      })
    },
    [commit]
  )

  const deleteTrack = useCallback(
    (trackId: number) => {
      commit('Track deleted', (d) => {
        d.tracks = d.tracks.filter((t) => t.id !== trackId)
      })
      onTrackDeleted(trackId)
    },
    [commit, onTrackDeleted]
  )

  const renameTrack = useCallback(
    (trackId: number, name: string) => {
      commit('Track renamed', (d) => {
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
      commit('Clip renamed', (d) => {
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

  const copyClips = useCallback(
    (clipIds: number[]) => {
      const items = tracks.flatMap((t) =>
        t.clips.filter((c) => clipIds.includes(c.id)).map((clip) => ({ clip, trackId: t.id }))
      )
      if (items.length === 0) return
      clipClipboard.current = items
      setCanPaste(true)
      setLog(`${count(items.length, 'clip')} copied`)
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
      commit(`${count(items.length, 'clip')} pasted`, (d) => {
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
      commit(`${count(pairs.length, 'clip')} duplicated`, (d) => {
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
          commit(`${count(targetIds.length, 'clip')} ${clip.muted ? 'unmuted' : 'muted'}`, (d) => {
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
          commit('Clip split', (d) => {
            const c = inDoc(d)
            if (!c) return
            const t = d.tracks.find((t) => t.clips.some((c) => c.id === clipId))
            t?.clips.push({ ...c, id, offset: playhead, trimIn: local })
            c.trimOut = local
          })
          break
        }
        // Reveal only the clicked clip, even inside a multi-selection: one
        // Finder window, not one per selected clip.
        case 'reveal':
          window.api.clip.reveal(clip.file).catch((e) => setError((e as Error).message))
          break
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

  const duplicateSelected = useCallback(() => {
    if (selectedIds.length > 0) duplicateClips(selectedIds)
  }, [selectedIds, duplicateClips])

  // The curve panel shows every selected clip's events; with no clip
  // selected, the selected tracks' clips. Deselecting doesn't clear it:
  // the panel keeps the last selection until a new one replaces it.
  const [curveSel, setCurveSel] = useState<{ clipIds: number[]; trackIds: number[] }>({
    clipIds: [],
    trackIds: []
  })
  useEffect(() => {
    if (selectedIds.length > 0) setCurveSel({ clipIds: selectedIds, trackIds: [] })
    else if (selectedTrackIds.length > 0) setCurveSel({ clipIds: [], trackIds: selectedTrackIds })
  }, [selectedIds, selectedTrackIds])
  const curveClips = React.useMemo(() => {
    if (curveSel.clipIds.length > 0) {
      return tracks.flatMap((t) => t.clips).filter((c) => curveSel.clipIds.includes(c.id))
    }
    return tracks.filter((t) => curveSel.trackIds.includes(t.id)).flatMap((t) => t.clips)
  }, [tracks, curveSel])

  const onPointEdit = useCallback(
    (patches: PointPatch[], isCommit: boolean) => {
      if (patches.length === 0) return
      const apply = (d: Doc): void => applyPointPatches(d.edits, patches)
      if (isCommit) commit(`${count(patches.length, 'point')} edited`, apply)
      else transient(apply)
    },
    [commit, transient]
  )

  // New points append to the clips' edit overlays and become the selection.
  // A pencil stroke streams single adds (transient), then commits the whole
  // batch on release so the stroke is one undo entry.
  const onPointAdd = useCallback(
    (adds: PointAdd[], isCommit: boolean) => {
      if (adds.length === 0) return
      const apply = (d: Doc): void =>
        addPoints(
          d.edits,
          adds.map((a) => ({ file: a.sel.file, ev: a.ev }))
        )
      if (isCommit) commit(`${count(adds.length, 'point')} added`, apply)
      else transient(apply)
      setSelectedPoints(adds.map((a) => a.sel))
    },
    [commit, transient]
  )

  // Replace with Curve: one undo entry deletes the covered events and
  // appends the fitted curves to the clips' overlays. A new curve carves
  // its span out of same-(port, a, arg) curves already in the overlay, so
  // re-replacing a range never leaves two curves competing for it.
  const onCurveReplace = useCallback(
    (dels: { file: string; eventIndex: number }[], adds: { file: string; curve: ClipCurve }[]) => {
      if (adds.length === 0) return
      commit(`${count(dels.length, 'point')} replaced with curve`, (d) =>
        replaceWithCurves(d.edits, dels, adds)
      )
      setSelectedPoints([])
    },
    [commit]
  )

  const deleteSelectedPoints = useCallback(() => {
    if (selectedPoints.length === 0) return
    commit(`${count(selectedPoints.length, 'point')} deleted`, (d) =>
      deletePoints(d.edits, selectedPoints)
    )
    setSelectedPoints([])
  }, [selectedPoints, commit])

  const alignAll = useCallback(() => {
    commit('Clips aligned with clock', (d) => {
      for (const t of d.tracks) {
        for (const c of t.clips) c.offset = alignClip(c).offset
      }
    })
  }, [commit])

  // Delete selected curve points, else selected clips.
  const deleteSelected = useCallback(() => {
    if (selectedPoints.length > 0) {
      deleteSelectedPoints()
      return
    }
    if (selectedIds.length === 0) return
    commit(`${count(selectedIds.length, 'clip')} deleted`, (d) => {
      for (const t of d.tracks) t.clips = t.clips.filter((c) => !selectedIds.includes(c.id))
    })
    setSelectedIds([])
  }, [selectedIds, selectedPoints, deleteSelectedPoints, commit])

  useShortcuts({
    openProject,
    saveProject,
    saveProjectAs,
    copySelected,
    pasteAtPlayhead,
    duplicateSelected,
    togglePlay,
    addMarker,
    deleteSelected,
    undo,
    redo,
    recording: !!recording
  })

  // The zoom floor drops below MIN_PX_PER_SEC when the timeline is too long
  // to fit the window at 2px/s, so zooming all the way out always shows it all.
  const [winW, setWinW] = useState(window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const timelineEnd = Math.max(duration, contentEnd(tracks))
  const minPxPerSec = Math.min(
    MIN_PX_PER_SEC,
    Math.max((winW - LABEL_W - TAIL_PAD) / timelineEnd, MIN_PX_PER_SEC / 1000)
  )

  const zoom = useCallback(
    (factor: number) => {
      setPxPerSec((z) => Math.min(Math.max(z * factor, minPxPerSec), MAX_PX_PER_SEC))
    },
    [minPxPerSec]
  )

  const setZoom = useCallback(
    (px: number) => {
      setPxPerSec(Math.min(Math.max(px, minPxPerSec), MAX_PX_PER_SEC))
    },
    [minPxPerSec]
  )

  // A shrinking timeline or widening window can raise the floor above the
  // current zoom; pull the zoom back up to it.
  useEffect(() => {
    setPxPerSec((z) => Math.max(z, minPxPerSec))
  }, [minPxPerSec])

  const hasTl = tracks.some((t) => t.clips.some((c) => c.summary.tlOffset != null))

  // Quantized to 10ms so mouse moves that keep the value only re-render then.
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const onHoverTime = useCallback((t: number | null): void => {
    setHoverTime(t == null ? null : Math.round(t * 100) / 100)
  }, [])

  let selection: string | null = null
  if (selectedPoints.length > 0) {
    selection = `${selectedPoints.length} point${selectedPoints.length > 1 ? 's' : ''}`
  } else if (selectedIds.length > 0) {
    let len = 0
    for (const t of tracks)
      for (const c of t.clips) if (selectedIds.includes(c.id)) len += clipLen(c)
    selection = `${selectedIds.length} clip${selectedIds.length > 1 ? 's' : ''} · ${len.toFixed(2)}s`
  } else if (selectedTrackIds.length > 0) {
    selection = `${selectedTrackIds.length} track${selectedTrackIds.length > 1 ? 's' : ''}`
  }

  return (
    <div className="app">
      <header className="header">
        {/* Two rows, like the port grid: the logo, then the timeline duration. */}
        <div className="header-left">
          <div className="header-left-grid">
            <div className="logo-row">
              <span className="logo">VTR</span>
              <FileMenu
                onOpen={openProject}
                onSave={saveProject}
                onSaveAs={saveProjectAs}
                onExport={doExport}
                exportDisabled={tracks.length === 0 || !!recording}
              />
              {/* The hidden native title bar used to carry these. */}
              <span className="header-file">
                {fileName ?? 'Untitled'}
                {dirty && ' •'}
              </span>
            </div>
            <div className="header-duration">
              <NumField
                label="dur"
                ariaLabel="timeline duration"
                value={duration}
                parse={parseDuration}
                onInput={(n) =>
                  transient((d) => {
                    d.duration = n
                  })
                }
                onCommit={(n) =>
                  commit('Duration changed', (d) => {
                    d.duration = n
                  })
                }
                dragStep={1}
              />
              <span className="toolbar-unit">s</span>
            </div>
          </div>
        </div>
        {/* Timecode + transport, centered between the equal-flex side groups. */}
        <div className="header-center">
          <Timecode
            recStartedAt={recording?.startedAt ?? null}
            playing={playing}
            playhead={playhead}
          />
          <button
            className={recording ? 'btn-icon rec active' : 'btn-icon rec'}
            onClick={toggleRecord}
            disabled={busy}
            aria-label={recording ? 'Stop' : 'Rec'}
            data-tip={recording ? 'Stop' : 'Rec'}
          >
            {recording ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <Circle size={14} fill="currentColor" />
            )}
          </button>
          <button
            className={playing ? 'btn-icon play active' : 'btn-icon play'}
            onClick={togglePlay}
            disabled={busy || !!recording || tracks.length === 0}
            aria-label={playing ? 'Pause' : 'Play'}
            data-tip={playing ? 'Pause' : 'Play'}
          >
            {playing ? (
              <Pause size={14} fill="currentColor" />
            ) : (
              <Play size={14} fill="currentColor" />
            )}
          </button>
        </div>
        <div className="header-right">
          {/* Row 1: in/out ports + tap on/off + recv rate.
              Row 2: ctrl port + sync on/off + drop count.
              The first stat column carries the ports/stats divider. */}
          <div className="status-grid">
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
            <span className="stat divider" data-tip="vtr-tap process status">
              <span>tap:</span>
              <span className={statusError ? 'bad' : status ? 'ok' : ''}>
                {statusError ? 'off' : status ? 'on' : '…'}
              </span>
            </span>
            <span className="stat" data-tip="incoming OSC packets per second">
              <span>recv:</span>
              <span>
                {status == null || rxRate == null
                  ? '–'
                  : `${rxRate < 10 ? rxRate.toFixed(1) : Math.round(rxRate)}/s`}
              </span>
            </span>
            <NumField
              label="echo"
              ariaLabel="echo port"
              value={ports.echo}
              disabled={!!recording || !!playing}
              parse={parsePort}
              onCommit={(echo) => changePorts({ ...ports, echo })}
            />
            <TextField
              label="to"
              ariaLabel="echo host"
              value={ports.echoHost}
              placeholder="auto"
              disabled={!!recording || !!playing}
              valid={isValidEchoHost}
              onCommit={(echoHost) => changePorts({ ...ports, echoHost })}
            />
            <span
              className="stat divider"
              data-tip={
                playerStatus
                  ? playerStatus.loaded
                    ? `${playerStatus.loaded.split(/[\\/]/).pop()} @ ${playerStatus.playhead.toFixed(2)}s` +
                      (playerStatus.playing ? ' (playing)' : '')
                    : 'vtr-player running, no session loaded'
                  : 'vtr-player not running'
              }
            >
              <span>player:</span>
              <span className={playerStatus ? 'ok' : ''}>{playerStatus ? 'on' : 'off'}</span>
            </span>
            <span
              className={status != null && status.dropped > 0 ? 'stat bad' : 'stat'}
              data-tip="packets lost to writer backlog since this clip started"
            >
              <span>drop:</span>
              <span>{status?.dropped ?? '–'}</span>
            </span>
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <Timeline
        tracks={tracks}
        markers={markers}
        pxPerSec={pxPerSec}
        minPxPerSec={minPxPerSec}
        duration={duration}
        selectedIds={selectedIds}
        selectedTrackIds={selectedTrackIds}
        recordingRow={
          recording
            ? {
                events: status?.events ?? 0,
                warning: status
                  ? recordingWarning(status.dropped, status.write_errors, status.write_error)
                  : null
              }
            : null
        }
        playhead={playhead}
        playing={playing}
        onSeek={onSeek}
        onSelect={selectClip}
        onSelectMany={selectClips}
        onSelectTrack={selectTrack}
        onTracksChange={onTracksChange}
        onDragCancel={abortTransient}
        onAddTrack={addTrack}
        onAddMarker={addMarker}
        onAlign={alignAll}
        canAlign={hasTl}
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
        onHoverTime={onHoverTime}
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
        onPointerCancel={() => {
          splitDrag.current = null
        }}
      />

      <CurvePanel
        clips={curveClips}
        height={curveHeight}
        edits={edits}
        playhead={playhead}
        playing={playing}
        onSeek={onSeek}
        selectedPoints={selectedPoints}
        onSelectPoints={setSelectedPoints}
        onPointEdit={onPointEdit}
        onPointAdd={onPointAdd}
        onCurveReplace={onCurveReplace}
      />
      <StatusBar hoverTime={hoverTime} selection={selection} log={log} />
      <TooltipLayer />
    </div>
  )
}

export default App
