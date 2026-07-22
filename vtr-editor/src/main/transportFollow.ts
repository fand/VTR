import { EDITOR_ORIGIN } from './player'
import type { TransportState } from '../shared/types'

/** Minimal slice of PlayerManager the follow loop needs. */
export interface Watchable {
  watch(gen: number): Promise<TransportState>
}

const RECONNECT_MS = 1000

/**
 * Long-poll loop that mirrors the player's push transport into the editor.
 * It keeps one `watch` outstanding, and on every *foreign* change (a seek
 * or play/stop that did not originate in the editor — i.e. from TD or a
 * controller) invokes `onForeign` so the renderer can move its playhead.
 *
 * Echo suppression is by origin: the editor's own writes come back tagged
 * `editor` and are skipped. Timeouts (same gen) are skipped too, so a
 * foreign state is applied once, not re-applied every poll. A watch error
 * (player down/restarting) backs off and re-baselines from gen 0 — a
 * reconnect's first reply is the current state, whoever owns it.
 */
export class TransportFollow {
  private running = false
  private gen = 0

  constructor(
    private player: Watchable,
    private onForeign: (state: TransportState) => void,
    private reconnectMs = RECONNECT_MS
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let s: TransportState
      try {
        s = await this.player.watch(this.gen)
      } catch {
        this.gen = 0 // reconnect re-baselines from the current state
        await new Promise((r) => setTimeout(r, this.reconnectMs))
        continue
      }
      if (s.gen === this.gen) continue // timeout: nothing changed
      this.gen = s.gen
      if (s.origin !== EDITOR_ORIGIN) this.onForeign(s)
    }
  }
}
