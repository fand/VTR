import { ChildProcess, spawn } from 'child_process'
import net from 'net'
import { join } from 'path'
import {
  RELAY_PORT,
  type ClipCurve,
  type OscEvent,
  type PlayerStatus,
  type TransportState
} from '../shared/types'

const REQUEST_TIMEOUT_MS = 3000
/** Long-poll requests (watch) must outlive vtr-player's ~1s server timeout. */
const WATCH_TIMEOUT_MS = 5000
const CONNECT_DEADLINE_MS = 5000
const RESPAWN_DELAY_MS = 1000
const RESPAWN_DELAY_MAX_MS = 10_000

/** The editor's own origin tag on transport writes (for echo suppression). */
export const EDITOR_ORIGIN = 'editor'

/** Transport snapshot carried by play/stop/seek replies. */
function toTransportState(r: Record<string, unknown>): TransportState {
  return {
    gen: Number(r.gen ?? 0),
    origin: String(r.origin ?? ''),
    playhead: Number(r.playhead ?? 0),
    playing: Boolean(r.playing)
  }
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/**
 * One control-socket connection with id-matched request/reply framing.
 * The server handles each connection's lines strictly in order, so a
 * blocking long-poll would head-of-line-delay every other request on the
 * same socket — the manager therefore keeps commands and the watch
 * long-poll on separate Channels.
 */
class Channel {
  private sock: net.Socket | null = null
  private connecting: Promise<net.Socket> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buf = ''

  constructor(private sockPath: string) {}

  async request(
    cmd: string,
    extra: Record<string, unknown> | undefined,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const sock = await this.connect()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const entry: Pending = {
        resolve: (v) => {
          clearTimeout(entry.timer)
          if (v.ok) resolve(v)
          else reject(new Error(String(v.error ?? 'vtr-player error')))
        },
        reject: (e) => {
          clearTimeout(entry.timer)
          reject(e)
        },
        timer: setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`vtr-player ${cmd}: timed out`))
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      sock.write(JSON.stringify({ id, cmd, ...extra }) + '\n')
    })
  }

  drop(err: Error): void {
    this.sock?.destroy()
    this.sock = null
    this.buf = ''
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) p.reject(err)
  }

  private connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock)
    // Share one in-flight connect so concurrent callers never open two sockets.
    this.connecting ??= this.connectWithRetry().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connectWithRetry(): Promise<net.Socket> {
    const deadline = Date.now() + CONNECT_DEADLINE_MS
    for (;;) {
      try {
        return await this.tryConnect()
      } catch (e) {
        if (Date.now() > deadline) throw e
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  }

  private tryConnect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.sockPath)
      sock.once('connect', () => {
        sock.on('data', (chunk) => this.onData(chunk))
        sock.on('close', () => {
          if (this.sock === sock) this.drop(new Error('control socket closed'))
        })
        sock.on('error', () => {})
        this.sock = sock
        resolve(sock)
      })
      sock.once('error', (e) => {
        sock.destroy()
        reject(e)
      })
    })
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString()
    for (;;) {
      const nl = this.buf.indexOf('\n')
      if (nl < 0) return
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        console.error(`vtr-player: unparseable control reply: ${line}`)
        continue
      }
      // Match by id; drop replies to unknown (e.g. timed-out) requests.
      const entry = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
      if (!entry) continue
      this.pending.delete(msg.id as number)
      entry.resolve(msg)
    }
  }
}

/**
 * Spawns vtr-player as a child process (no launchd mode — recording never
 * depends on it), respawns it on crash, and talks to its unix socket
 * control API (JSON Lines, one response per request line). Modeled on
 * TapManager. Commands and the watch long-poll ride separate connections
 * (see Channel).
 */
export class PlayerManager {
  readonly sockPath: string
  private proc: ChildProcess | null = null
  private cmds: Channel
  private poll: Channel
  private stopping = false
  private restarting = false
  private respawnDelay = RESPAWN_DELAY_MS
  private spawnedAt = 0

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
    this.cmds = new Channel(this.sockPath)
    this.poll = new Channel(this.sockPath)
  }

  /** Change the echo target and restart vtr-player with the new config. */
  setEcho(port: number, host: string): void {
    if (port === this.echoPort && host === this.echoHost) return
    this.echoPort = port
    this.echoHost = host
    this.respawnDelay = RESPAWN_DELAY_MS
    this.dropConnection(new Error('vtr-player restarting'))
    if (this.proc) {
      this.restarting = true
      this.proc.kill()
    } else {
      this.spawnPlayer()
    }
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
    if (this.stopping || this.proc) return
    // Piped stdin + --exit-on-stdin-close: the player exits if the editor dies hard.
    const proc = spawn(this.bin, [...this.playerArgs(), '--exit-on-stdin-close'], {
      stdio: ['pipe', 'ignore', 'pipe']
    })
    this.spawnedAt = Date.now()
    proc.stderr?.on('data', (d: Buffer) => console.log(`[vtr-player] ${d.toString().trimEnd()}`))
    // 'error' fires instead of 'exit' when the spawn itself fails (binary
    // missing mid-rebuild, EAGAIN…) and may fire alongside it; both funnel
    // into one guarded handler so every death drops the connection and
    // respawns exactly once.
    let dead = false
    const died = (why: string): void => {
      if (dead) return
      dead = true
      this.proc = null
      this.dropConnection(new Error('vtr-player exited'))
      if (this.stopping) return
      if (this.restarting) {
        this.restarting = false
        this.respawnDelay = RESPAWN_DELAY_MS
        this.spawnPlayer()
        return
      }
      // Back off when the player dies right after spawning (bad args, port in use…).
      const lived = Date.now() - this.spawnedAt
      this.respawnDelay =
        lived < 2000 ? Math.min(this.respawnDelay * 2, RESPAWN_DELAY_MAX_MS) : RESPAWN_DELAY_MS
      console.log(`${why}, respawning in ${this.respawnDelay}ms`)
      setTimeout(() => this.spawnPlayer(), this.respawnDelay)
    }
    proc.on('exit', (code, signal) => died(`vtr-player exited (${code ?? signal})`))
    proc.on('error', (e) => died(`vtr-player spawn failed: ${e.message}`))
    this.proc = proc
    // Re-push the resident session: without this, resolve clients (the TD
    // tox on an editor session) get "no session loaded" until the next
    // edit re-triggers the renderer's residency load. The lazy connect
    // waits out the player's startup.
    const l = this.lastLoad
    if (l) {
      this.loadInline(l.events, l.curves, l.duration, l.routes).catch((e) =>
        console.log(`residency re-push failed: ${(e as Error).message}`)
      )
    }
  }

  shutdown(): void {
    this.stopping = true
    this.dropConnection(new Error('shutting down'))
    this.proc?.kill()
    this.proc = null
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
   * The follow loop re-issues on every resolution. Rides its own
   * connection: the server blocks the whole connection while a watch is
   * pending, and the change that would wake it could be a command queued
   * on the same socket.
   */
  async watch(gen: number): Promise<TransportState> {
    const r = await this.poll.request('watch', { gen }, WATCH_TIMEOUT_MS)
    return {
      gen: Number(r.gen ?? 0),
      origin: String(r.origin ?? ''),
      playhead: Number(r.t ?? 0),
      playing: Boolean(r.playing)
    }
  }

  private request(
    cmd: string,
    extra?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.cmds.request(cmd, extra, this.requestTimeoutMs)
  }

  private dropConnection(err: Error): void {
    this.cmds.drop(err)
    this.poll.drop(err)
  }
}
