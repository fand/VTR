import { ChildProcess, spawn } from 'child_process'
import net from 'net'
import { join } from 'path'
import { RELAY_PORT, type OscEvent, type PlayerStatus, type TransportState } from '../shared/types'

const REQUEST_TIMEOUT_MS = 3000
/** Long-poll requests (watch) must outlive vtr-player's ~1s server timeout. */
const WATCH_TIMEOUT_MS = 5000
const CONNECT_DEADLINE_MS = 5000
const RESPAWN_DELAY_MS = 1000
const RESPAWN_DELAY_MAX_MS = 10_000

/** The editor's own origin tag on transport writes (for echo suppression). */
export const EDITOR_ORIGIN = 'editor'

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Spawns vtr-player as a child process (no launchd mode — recording never
 * depends on it), respawns it on crash, and talks to its unix socket
 * control API (JSON Lines, one response per request line). Modeled on
 * TapManager.
 */
export class PlayerManager {
  readonly sockPath: string
  private proc: ChildProcess | null = null
  private sock: net.Socket | null = null
  private connecting: Promise<net.Socket> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buf = ''
  private stopping = false
  private restarting = false
  private respawnDelay = RESPAWN_DELAY_MS
  private spawnedAt = 0

  constructor(
    private bin: string,
    /** App-owned dir for the control socket. */
    readonly dataDir: string,
    private echoPort: number,
    /** Tap control socket the player follows for rec-state echo. */
    private tapSockPath: string,
    private requestTimeoutMs = REQUEST_TIMEOUT_MS
  ) {
    this.sockPath = join(dataDir, 'vtr-player.sock')
  }

  /** Change the echo port and restart vtr-player with the new config. */
  setEchoPort(port: number): void {
    if (port === this.echoPort) return
    this.echoPort = port
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
      '--tap-control',
      this.tapSockPath
    ]
  }

  spawnPlayer(): void {
    if (this.stopping || this.proc) return
    // Piped stdin + --exit-on-stdin-close: the player exits if the editor dies hard.
    const proc = spawn(this.bin, [...this.playerArgs(), '--exit-on-stdin-close'], {
      stdio: ['pipe', 'ignore', 'pipe']
    })
    this.spawnedAt = Date.now()
    proc.stderr?.on('data', (d: Buffer) => console.log(`[vtr-player] ${d.toString().trimEnd()}`))
    proc.on('exit', (code, signal) => {
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
      console.log(`vtr-player exited (${code ?? signal}), respawning in ${this.respawnDelay}ms`)
      setTimeout(() => this.spawnPlayer(), this.respawnDelay)
    })
    proc.on('error', (e) => {
      this.proc = null
      console.error(`vtr-player spawn failed: ${e.message}`)
    })
    this.proc = proc
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
   * Inline-load the current merged project (no file involved) so sync
   * clients (the TD tox) resolve against what the editor is playing.
   * No routes: the player's own push transport stays silent — the editor
   * keeps pushing preview OSC to the app itself.
   */
  async loadInline(events: OscEvent[], duration: number): Promise<void> {
    await this.request('load', { events, duration, name: '(editor)' })
  }

  async play(origin: string = EDITOR_ORIGIN): Promise<void> {
    await this.request('play', { origin })
  }

  async stopTransport(origin: string = EDITOR_ORIGIN): Promise<void> {
    await this.request('stop', { origin })
  }

  async seek(t: number, origin: string = EDITOR_ORIGIN): Promise<void> {
    await this.request('seek', { t, origin })
  }

  /**
   * Long-poll the transport: resolves when its generation differs from
   * `gen`, or vtr-player's server-side timeout fires (same gen returned).
   * The follow loop re-issues on every resolution.
   */
  async watch(gen: number): Promise<TransportState> {
    const r = await this.request('watch', { gen }, WATCH_TIMEOUT_MS)
    return {
      gen: Number(r.gen ?? 0),
      origin: String(r.origin ?? ''),
      playhead: Number(r.t ?? 0),
      playing: Boolean(r.playing)
    }
  }

  private async request(
    cmd: string,
    extra?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs
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
          if (this.sock === sock) this.dropConnection(new Error('control socket closed'))
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

  private dropConnection(err: Error): void {
    this.sock?.destroy()
    this.sock = null
    this.buf = ''
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) p.reject(err)
  }
}
