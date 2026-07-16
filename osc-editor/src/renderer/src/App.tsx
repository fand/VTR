import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_PORTS, type PortConfig, type TapStatus } from '../../shared/types'
import { PlayingState, Timeline } from './components/Timeline'
import {
  TrackState,
  alignClip,
  serializeProject,
  tracksFromProject
} from './timeline/model'

const MIN_PX_PER_SEC = 2
const MAX_PX_PER_SEC = 400

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
  return <div className={recStartedAt != null ? 'timecode rec' : 'timecode'}>{formatTimecode(Math.max(0, secs))}</div>
}

function PortField({
  label,
  value,
  disabled,
  onCommit
}: {
  label: string
  value: number
  disabled: boolean
  onCommit: (port: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = parseInt(draft, 10)
    if (Number.isInteger(n) && n >= 1 && n <= 65535 && n !== value) onCommit(n)
    else setDraft(String(value))
  }
  return (
    <label className="port-field">
      {label}
      <input
        value={draft}
        disabled={disabled}
        inputMode="numeric"
        aria-label={`${label} port`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </label>
  )
}

function App(): React.JSX.Element {
  const [recording, setRecording] = useState<{ path: string; startedAt: number } | null>(null)
  const [tracks, setTracks] = useState<TrackState[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [pxPerSec, setPxPerSec] = useState(20)
  const [status, setStatus] = useState<TapStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState<PlayingState | null>(null)
  const [ports, setPorts] = useState<PortConfig>(DEFAULT_PORTS)
  const nextId = useRef(1)
  const loaded = useRef(false)
  const newId = useCallback((): number => nextId.current++, [])

  // Load project.json once at boot.
  useEffect(() => {
    window.api.project
      .load()
      .then((project) => {
        if (project) {
          setTracks(tracksFromProject(project, newId))
          if (project.ports) {
            setPorts(project.ports)
            window.api.tap.setPorts(project.ports).catch((e: Error) => setError(e.message))
          }
          if (project.missing.length > 0) {
            setError(`missing clip files: ${project.missing.join(', ')}`)
          }
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        loaded.current = true
      })
  }, [newId])

  // Autosave (debounced), but never before the initial load finished.
  useEffect(() => {
    if (!loaded.current) return
    const timer = setTimeout(() => {
      window.api.project
        .save(serializeProject(tracks, ports))
        .catch((e: Error) => setError(e.message))
    }, 400)
    return () => clearTimeout(timer)
  }, [tracks, ports])

  const changePorts = useCallback(
    (next: PortConfig) => {
      setPorts(next)
      window.api.tap.setPorts(next).catch((e: Error) => setError(e.message))
    },
    []
  )

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
        setTracks((ts) => [
          ...ts,
          {
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
        ])
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

  const onTracksChange = useCallback((next: TrackState[], commit: boolean) => {
    setTracks(commit ? next.filter((t) => t.clips.length > 0) : next)
  }, [])

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
      const { duration } = await window.api.preview.play(serializeProject(tracks, ports), playhead)
      setPlaying({ startPos: playhead, startedAt: performance.now(), duration })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [playing, tracks, ports, playhead, stopPreview])

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
      const result = await window.api.session.export(serializeProject(tracks, ports))
      setInfo(`exported ${result.path} (${result.events} events, ${result.duration.toFixed(1)}s)`)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [tracks, ports])

  // Info banner auto-hide.
  useEffect(() => {
    if (!info) return
    const timer = setTimeout(() => setInfo(null), 5000)
    return () => clearTimeout(timer)
  }, [info])

  // Space toggles preview unless recording.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || recording) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, recording])

  const alignAll = useCallback(() => {
    setTracks((ts) => ts.map((t) => ({ ...t, clips: t.clips.map(alignClip) })))
  }, [])

  // Delete selected clip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (selectedId == null) return
      setTracks((ts) =>
        ts
          .map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== selectedId) }))
          .filter((t) => t.clips.length > 0)
      )
      setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId])

  const zoom = useCallback((factor: number) => {
    setPxPerSec((z) => Math.min(Math.max(z * factor, MIN_PX_PER_SEC), MAX_PX_PER_SEC))
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
        <PortField
          label="in"
          value={ports.listen}
          disabled={!!recording || !!playing}
          onCommit={(listen) => changePorts({ ...ports, listen })}
        />
        <span className="port-arrow">→</span>
        <PortField
          label="out"
          value={ports.forward}
          disabled={!!recording || !!playing}
          onCommit={(forward) => changePorts({ ...ports, forward })}
        />
        <button className="btn" onClick={() => zoom(1 / 1.5)} title="zoom out">
          −
        </button>
        <button className="btn" onClick={() => zoom(1.5)} title="zoom in">
          +
        </button>
        <button className="btn" onClick={doExport} disabled={tracks.length === 0 || !!recording}>
          Export
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {info && <div className="info-banner">{info}</div>}

      <Timeline
        tracks={tracks}
        pxPerSec={pxPerSec}
        selectedId={selectedId}
        recordingRow={recording ? { events: status?.events ?? 0 } : null}
        playhead={playhead}
        playing={playing}
        onSeek={onSeek}
        onSelect={setSelectedId}
        onTracksChange={onTracksChange}
      />

      <footer className="statusbar">
        <span className={statusError ? 'chip bad' : status ? 'chip ok' : 'chip'}>
          tap {statusError ? 'down' : status ? 'up' : '…'}
        </span>
        <span className={status?.beacon_tl != null ? 'chip ok' : 'chip'}>
          {status?.beacon_tl != null
            ? `beacon tl=${status.beacon_tl.toFixed(2)}s (${status.beacon_age?.toFixed(1)}s ago)`
            : 'no beacon'}
        </span>
        {status != null && status.dropped > 0 && (
          <span className="chip bad">dropped {status.dropped}</span>
        )}
      </footer>
    </div>
  )
}

export default App
