import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlayerStatus, TapStatus } from '../../shared/types'

/**
 * vtr-tap / vtr-player process status polling and the recording state.
 * Recording is event-driven: local and remote (OSC /rec) start/stops flow
 * through the same tap:event channel; local commands only fire and report
 * errors.
 */
export function useTapStatus(opts: {
  /** Baseline snapshot waits for boot, so a lingering last_clip dedupes
   *  against the loaded project instead of racing it. */
  bootDone: boolean
  /** A finished clip appeared (record stop / reset snapshot). */
  importClip: (clipPath: string) => void
  setError: (msg: string | null) => void
  setLog: (msg: string) => void
}): {
  status: TapStatus | null
  statusError: string | null
  playerStatus: PlayerStatus | null
  rxRate: number | null
  recording: { path: string; startedAt: number } | null
  busy: boolean
  toggleRecord: () => Promise<void>
} {
  const { bootDone, importClip, setError, setLog } = opts
  const [recording, setRecording] = useState<{ path: string; startedAt: number } | null>(null)
  const [status, setStatus] = useState<TapStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null)
  /** Incoming packets/s, from received deltas between polls. */
  const [rxRate, setRxRate] = useState<number | null>(null)
  const lastRx = useRef<{ received: number; at: number } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const poll = (): void => {
      window.api.tap
        .status()
        .then((s) => {
          setStatus(s)
          setStatusError(null)
          // A stale launchd tap may predate the received field.
          if (typeof s.received === 'number') {
            const now = performance.now()
            const prev = lastRx.current
            lastRx.current = { received: s.received, at: now }
            // A negative delta means vtr-tap restarted; skip that sample.
            if (prev && now > prev.at && s.received >= prev.received) {
              setRxRate(((s.received - prev.received) * 1000) / (now - prev.at))
            }
          }
          // Disk full mid-performance must not fail silently: the latch
          // keeps this banner up until the next recording starts.
          if (s.write_error) {
            setError(`recording write error (${s.write_errors} failed): ${s.write_error}`)
          }
        })
        .catch((e: Error) => setStatusError(e.message))
      window.api.player
        .status()
        .then(setPlayerStatus)
        .catch(() => setPlayerStatus(null))
    }
    poll()
    const iv = setInterval(poll, 1000)
    return () => clearInterval(iv)
  }, [setError])

  // Apply a status snapshot (startup baseline / tap reset), idempotently.
  const applySnapshot = useCallback(
    (s: TapStatus): void => {
      if (s.recording && s.clip) {
        const clip = s.clip
        const recT = s.rec_t ?? 0
        setRecording((prev) =>
          prev && prev.path === clip
            ? prev
            : { path: clip, startedAt: performance.now() - recT * 1000 }
        )
      } else {
        // Tap crashed or stopped while we weren't looking: clear stale REC.
        setRecording(null)
      }
      if (s.last_clip) importClip(s.last_clip)
    },
    [importClip]
  )

  useEffect(() => {
    return window.api.tap.onEvent((msg) => {
      if (msg.type === 'reset') {
        applySnapshot(msg.status)
        return
      }
      const e = msg.event
      if (e.ev === 'rec_started') {
        // A snapshot may already have applied this; keep startedAt then.
        setRecording((prev) =>
          prev && prev.path === e.clip ? prev : { path: e.clip, startedAt: performance.now() }
        )
        setLog('Record started')
      } else {
        setRecording(null)
        setLog('Record stopped')
        importClip(e.clip)
      }
    })
  }, [applySnapshot, importClip, setLog])

  // Startup baseline: events forwarded before this window existed are gone; a
  // status snapshot recovers the state.
  useEffect(() => {
    if (!bootDone) return
    let stop = false
    let timer: number | undefined
    const baseline = (): void => {
      window.api.tap
        .status()
        .then((s) => {
          if (!stop) applySnapshot(s)
        })
        .catch(() => {
          if (!stop) timer = window.setTimeout(baseline, 1000)
        })
    }
    baseline()
    return () => {
      stop = true
      window.clearTimeout(timer)
    }
  }, [bootDone, applySnapshot])

  const toggleRecord = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      if (recording) await window.api.tap.stop()
      else await window.api.tap.start()
      setError(null)
    } catch (e) {
      const msg = (e as Error).message
      // A remote stop won the race; its event already handled it.
      if (!msg.includes('not recording')) setError(msg)
    } finally {
      setBusy(false)
    }
  }, [recording, busy, setError])

  return { status, statusError, playerStatus, rxRate, recording, busy, toggleRecord }
}
