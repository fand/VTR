import { join } from 'path'
import {
  RELAY_PORT,
  type ClipCurve,
  type OscEvent,
  type PlayerStatus,
  type TransportState
} from '../shared/types'
import { ControlChannel } from './controlChannel'
import { ChildSupervisor } from './supervisor'

const REQUEST_TIMEOUT_MS = 3000
/** Long-poll requests (watch) must outlive vtr-player's ~1s server timeout. */
const WATCH_TIMEOUT_MS = 5000

/** The editor's own origin tag on transport writes (for echo suppression). */
export const EDITOR_ORIGIN = 'editor'

/** Transport snapshot carried by play/stop/seek/watch replies. */
function toTransportState(r: Record<string, unknown>): TransportState {
  return {
    gen: Number(r.gen ?? 0),
    origin: String(r.origin ?? ''),
    playhead: Number(r.playhead ?? 0),
    playing: Boolean(r.playing)
  }
}

/**
 * Spawns vtr-player via ChildSupervisor (no launchd mode — recording never
 * depends on it) and talks to its unix socket control API. Modeled on
 * TapManager: commands and the watch long-poll share one connection, since
 * the server answers a long poll off-thread.
 */
export class PlayerManager {
  readonly sockPath: string
  private chan: ControlChannel
  private child: ChildSupervisor
  private stopping = false

  constructor(
    private bin: string,
    /** App-owned dir for the control socket. */
    readonly dataDir: string,
    private echoPort: number,
    /** Pinned feedback target; empty = whoever vtr-player hears from. */
    private echoHost: string,
    /** Tap control socket the player follows for rec-state echo. */
    private tapSockPath: string,
    private requestTimeoutMs = REQUEST_TIMEOUT_MS
  ) {
    this.sockPath = join(dataDir, 'vtr-player.sock')
    this.chan = new ControlChannel(this.sockPath, 'vtr-player')
    this.child = new ChildSupervisor({
      label: 'vtr-player',
      bin: this.bin,
      args: () => this.playerArgs(),
      onExit: (err) => this.dropConnection(err),
      // Re-push the resident session: without this, resolve clients (the TD
      // tox on an editor session) get "no session loaded" until the next
      // edit re-triggers the renderer's residency load. The lazy connect
      // waits out the player's startup.
      onSpawned: () => {
        const l = this.lastLoad
        if (l) {
          this.loadInline(l.events, l.curves, l.duration, l.routes).catch((e) =>
            console.log(`residency re-push failed: ${(e as Error).message}`)
          )
        }
      }
    })
  }

  /** Change the echo target and restart vtr-player with the new config. */
  setEcho(port: number, host: string): void {
    if (port === this.echoPort && host === this.echoHost) return
    this.echoPort = port
    this.echoHost = host
    this.dropConnection(new Error('vtr-player restarting'))
    this.child.restart()
  }

  private playerArgs(): string[] {
    return [
      '--relay',
      `127.0.0.1:${RELAY_PORT}`,
      '--control',
      this.sockPath,
      '--echo-port',
      String(this.echoPort),
      ...(this.echoHost ? ['--echo-host', this.echoHost] : []),
      '--tap-control',
      this.tapSockPath
    ]
  }

  /** Last inline load, re-pushed after a respawn (a restarted player is empty). */
  private lastLoad: {
    events: OscEvent[]
    curves: ClipCurve[]
    duration: number
    routes: Record<string, number>
  } | null = null

  spawnPlayer(): void {
    if (this.stopping) return
    this.child.spawn()
  }

  shutdown(): void {
    this.stopping = true
    this.dropConnection(new Error('shutting down'))
    this.child.shutdown()
  }

  async status(): Promise<PlayerStatus> {
    const r = await this.request('status')
    return r.status as unknown as PlayerStatus
  }

  /**
   * Inline-load the current merged project (no file involved). The routes
   * make the player's emit loop the one preview emitter: it resolves the
   * push transport's playhead and sends to the routed ports, whoever
   * drives the transport (editor, TD sync, controllers). keep:true swaps
   * the session without touching the transport, so a residency reload
   * during playback never yanks followers to zero; origin tags the swap
   * as ours.
   */
  async loadInline(
    events: OscEvent[],
    curves: ClipCurve[],
    duration: number,
    routes: Record<string, number>
  ): Promise<void> {
    this.lastLoad = { events, curves, duration, routes }
    await this.request('load', {
      // Curve lines ride the same array; the player parses them by `type`.
      events: [...events, ...curves.map((c) => ({ type: 'curve', ...c }))],
      duration,
      routes,
      name: '(editor)',
      origin: EDITOR_ORIGIN,
      keep: true
    })
  }

  async play(origin: string = EDITOR_ORIGIN): Promise<TransportState> {
    return toTransportState(await this.request('play', { origin }))
  }

  async stopTransport(origin: string = EDITOR_ORIGIN): Promise<TransportState> {
    return toTransportState(await this.request('stop', { origin }))
  }

  async seek(t: number, origin: string = EDITOR_ORIGIN): Promise<TransportState> {
    return toTransportState(await this.request('seek', { t, origin }))
  }

  /**
   * Long-poll the transport: resolves when its generation differs from
   * `gen`, or vtr-player's server-side timeout fires (same gen returned).
   * The follow loop re-issues on every resolution. Shares the command
   * connection: the server answers a pending watch from its own thread, so
   * a command that would wake it is never stuck behind it.
   */
  async watch(gen: number): Promise<TransportState> {
    return toTransportState(await this.chan.request('watch', { gen }, WATCH_TIMEOUT_MS))
  }

  private request(cmd: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.chan.request(cmd, extra, this.requestTimeoutMs)
  }

  private dropConnection(err: Error): void {
    this.chan.drop(err)
  }
}
