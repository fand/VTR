import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectFile, TransportState } from '../../shared/types'
import type { PlayingState } from './components/Timeline'

/**
 * The playhead and preview playback, mirroring the player's shared push
 * transport (the single authoritative playhead — see ARCHITECTURE.md).
 */
export function useTransport(opts: {
  duration: number
  hasTracks: boolean
  /** Current project snapshot for preview:play. */
  serialize: () => ProjectFile
  setError: (msg: string | null) => void
  setLog: (msg: string) => void
}): {
  playhead: number
  playing: PlayingState | null
  togglePlay: () => Promise<void>
  pausePreview: () => Promise<void>
  onSeek: (sec: number) => void
} {
  const { duration, hasTracks, serialize, setError, setLog } = opts
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState<PlayingState | null>(null)

  // Follow the shared transport: a seek or play/stop from TD or a controller
  // (never the editor's own writes — those are suppressed in main). The
  // player emits the OSC for every transport move, so all the renderer does
  // is roll its local playhead clock to match.
  const playingRef = useRef(playing)
  useEffect(() => {
    playingRef.current = playing
  }, [playing])
  // Set once anything foreign has been applied: the boot seed below must
  // never overwrite a live update that beat it.
  const transportSeededRef = useRef(false)
  useEffect(() => {
    const apply = (s: TransportState): void => {
      transportSeededRef.current = true
      const p = playingRef.current
      setPlayhead(s.playhead)
      if (s.playing) {
        if (p && !p.remote) {
          // Foreign seek during editor playback: keep it editor-owned so
          // the end-of-project auto-pause still applies.
          setPlaying({ ...p, startPos: s.playhead, startedAt: performance.now() })
        } else {
          setPlaying({ startPos: s.playhead, startedAt: performance.now(), duration, remote: true })
        }
      } else {
        setPlaying(null)
      }
    }
    const unsub = window.api.preview.onTransport(apply)
    // Seed a fresh renderer from the last foreign state main saw — without
    // this the playhead assumes 0 until the next transport change (e.g. a
    // TD scrub that landed while the window was still loading).
    if (!transportSeededRef.current)
      window.api.preview
        .lastTransport()
        .then((s) => {
          if (s && !transportSeededRef.current) apply(s)
        })
        .catch(() => {})
    return unsub
  }, [duration])

  // Pause freezes the playhead where playback stopped; Play resumes from it.
  // The local clock is the immediate estimate; the stop reply carries the
  // player transport's exact position and wins when it arrives.
  const pausePreview = useCallback(async () => {
    if (playing) {
      setPlayhead(
        Math.min(
          playing.startPos + (performance.now() - playing.startedAt) / 1000,
          playing.duration
        )
      )
    }
    try {
      const res = await window.api.preview.stop()
      setPlayhead(playing ? Math.min(res.position, playing.duration) : res.position)
    } catch (e) {
      setError((e as Error).message)
    }
    if (playing) setLog('Playback paused')
    setPlaying(null)
  }, [playing, setError, setLog])

  // In-flight guard: two fast Space presses would both see playing === null
  // and both call preview.play; the second's startedAt then skews the playhead.
  const playFlight = useRef(false)
  const togglePlay = useCallback(async () => {
    if (playFlight.current) return
    playFlight.current = true
    try {
      if (playing) {
        await pausePreview()
        return
      }
      if (!hasTracks) return
      const res = await window.api.preview.play(serialize(), playhead)
      // The reply snapshot is the truth: the hold rule can reject our
      // writes while a foreign controller is still driving the transport.
      if (!res.transport.playing || res.transport.origin !== 'editor') {
        setLog('Transport busy — another controller is driving it')
        return
      }
      setPlaying({
        startPos: res.transport.playhead,
        startedAt: performance.now(),
        duration: res.duration
      })
      setLog('Playback started')
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      playFlight.current = false
    }
  }, [playing, hasTracks, serialize, playhead, pausePreview, setError, setLog])

  // Auto-pause when the playhead reaches the end. Remote-driven playback is
  // exempt: pausing would stop the shared transport someone else is driving.
  useEffect(() => {
    if (!playing || playing.remote) return
    const remaining =
      (playing.duration - playing.startPos) * 1000 - (performance.now() - playing.startedAt)
    const timer = setTimeout(() => pausePreview(), Math.max(remaining, 0) + 100)
    return () => clearTimeout(timer)
  }, [playing, pausePreview])

  // Every user seek writes the shared transport — idle included, so a TD
  // sync client follows the seekbar while the editor is stopped, and the
  // player pushes the resolved frame to TD (deduped). The visible playhead
  // is driven by `playing`, so we roll its origin forward to match the jump.
  const onSeek = useCallback(
    (sec: number) => {
      setPlayhead(sec)
      window.api.preview.seek(sec).catch((e) => setError((e as Error).message))
      if (!playing) return
      setPlaying((p) => (p ? { ...p, startPos: sec, startedAt: performance.now() } : p))
    },
    [playing, setError]
  )

  return { playhead, playing, togglePlay, pausePreview, onSeek }
}
