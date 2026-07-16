import dgram from 'node:dgram'
import type { OscEvent } from '../shared/types'
import { encodeOscMessage } from './osc'

const TARGET_HOST = '127.0.0.1'
/** Events due within this window are sent immediately. */
const LOOKAHEAD_S = 0.002

/**
 * Best-effort realtime playback of merged events to TD, for checking edits.
 * The final render never uses this path (it is file-driven inside TD).
 */
export class Preview {
  private sock = dgram.createSocket('udp4')
  private timer: NodeJS.Timeout | null = null
  private events: OscEvent[] = []
  private idx = 0
  private startPos = 0
  private startedAt = 0
  private targetPort = 10011

  get playing(): boolean {
    return this.timer !== null
  }

  position(): number {
    if (!this.playing) return this.startPos
    return this.startPos + (performance.now() - this.startedAt) / 1000
  }

  play(events: OscEvent[], fromSec: number, targetPort: number): void {
    this.stop()
    this.targetPort = targetPort
    this.events = events
    const idx = events.findIndex((e) => e.t >= fromSec)
    this.idx = idx < 0 ? events.length : idx
    this.startPos = fromSec
    this.startedAt = performance.now()
    this.timer = setTimeout(this.tick, 0)
  }

  /** Returns the frozen playhead position. */
  stop(): number {
    const pos = this.position()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.startPos = pos
    return pos
  }

  private tick = (): void => {
    const pos = this.startPos + (performance.now() - this.startedAt) / 1000
    while (this.idx < this.events.length && this.events[this.idx].t <= pos + LOOKAHEAD_S) {
      const e = this.events[this.idx++]
      try {
        this.sock.send(encodeOscMessage(e.a, e.args), this.targetPort, TARGET_HOST)
      } catch (err) {
        console.error(`preview send error: ${(err as Error).message}`)
      }
    }
    if (this.idx >= this.events.length) {
      // Freeze the playhead where playback ended.
      this.startPos = pos
      this.timer = null
      return
    }
    const delay = (this.events[this.idx].t - pos) * 1000
    this.timer = setTimeout(this.tick, Math.max(delay, 1))
  }
}
