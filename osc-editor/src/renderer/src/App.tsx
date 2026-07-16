import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipSummary, TapStatus } from '../../shared/types'

const PX_PER_SEC = 20

interface Track {
  id: number
  clip: ClipSummary
}

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

function Timecode({ startedAt }: { startedAt: number | null }): React.JSX.Element {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (startedAt == null) {
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
  }, [startedAt])
  const secs = startedAt == null ? 0 : Math.max(0, (now - startedAt) / 1000)
  return <div className="timecode">{formatTimecode(secs)}</div>
}

function App(): React.JSX.Element {
  const [recording, setRecording] = useState<{ path: string; startedAt: number } | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [status, setStatus] = useState<TapStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nextId = useRef(1)

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
        const clip = await window.api.tap.stop(recording.path)
        setTracks((ts) => [...ts, { id: nextId.current++, clip }])
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
  }, [recording, busy])

  return (
    <div className="app">
      <header className="header">
        <span className="logo">osc-mtr</span>
        <Timecode startedAt={recording?.startedAt ?? null} />
        <button
          className={recording ? 'btn rec active' : 'btn rec'}
          onClick={toggleRecord}
          disabled={busy}
        >
          {recording ? '■ Stop' : '● Rec'}
        </button>
        <div className="spacer" />
        <button className="btn" disabled title="not implemented yet">
          Export
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="tracks">
        {tracks.map((t, i) => (
          <div className="track" key={t.id}>
            <div className="track-label">Track {i + 1}</div>
            <div className="track-lane">
              <div className="clip" style={{ width: Math.max(t.clip.duration * PX_PER_SEC, 60) }}>
                <span className="clip-name">{t.clip.name}</span>
                <span className="clip-meta">
                  {t.clip.duration.toFixed(1)}s · {t.clip.events} ev
                  {t.clip.tlOffset != null && ` · tl+${t.clip.tlOffset.toFixed(2)}`}
                </span>
              </div>
            </div>
          </div>
        ))}
        {recording && (
          <div className="track">
            <div className="track-label">Track {tracks.length + 1}</div>
            <div className="track-lane">
              <div className="clip recording">
                <span className="clip-name">recording…</span>
                <span className="clip-meta">{status?.events ?? 0} ev</span>
              </div>
            </div>
          </div>
        )}
        {tracks.length === 0 && !recording && (
          <div className="empty">No clips. Hit ● Rec to record incoming OSC.</div>
        )}
      </div>

      <footer className="statusbar">
        <span className={statusError ? 'chip bad' : 'chip ok'}>
          tap {statusError ? 'down' : 'up'}
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
