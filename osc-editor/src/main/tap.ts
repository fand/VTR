import { ChildProcess, execFileSync, spawn } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import net from 'net'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  DEFAULT_PORTS,
  type PortConfig,
  type TapEvent,
  type TapStatus,
  type TapWaitReply
} from '../shared/types'

const REQUEST_TIMEOUT_MS = 3000
const CONNECT_DEADLINE_MS = 5000
const RESPAWN_DELAY_MS = 1000
const RESPAWN_DELAY_MAX_MS = 10_000
/** Above the tap's 25s server-side wait timeout: quiet waits return empty. */
const WAIT_TIMEOUT_MS = 30_000
const WAIT_RETRY_MS = 500
const WAIT_RETRY_MAX_MS = 5000

/**
 * child: osc-tap is our child process; we respawn it on crash.
 * launchd: osc-tap runs as a launchd user agent (KeepAlive on crash);
 *          survives an editor crash, bootout on clean editor exit.
 */
export type SpawnMode = 'child' | 'launchd'

const LAUNCHD_LABEL = 'com.fand.vtr.osc-tap'
// Pre-rename label; its RunAtLoad plist would keep an orphan tap on the ports.
const LEGACY_LAUNCHD_LABEL = 'com.osc-mtr.osc-tap'

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Spawns osc-tap as a child process, respawns it on crash, and talks to its
 * unix socket control API (JSON Lines, one response per request line).
 */
export class TapManager {
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
  /** Bumped on every dropped connection; wait cursors from before are stale. */
  private dropGen = 0

  private _ports: PortConfig

  constructor(
    private bin: string,
    /** App-owned dir for the control socket and launchd log. */
    readonly dataDir: string,
    /** Default recording dir (staging); start(dir) overrides per clip. */
    readonly outdir: string,
    private mode: SpawnMode = 'child',
    ports: PortConfig = DEFAULT_PORTS,
    private requestTimeoutMs = REQUEST_TIMEOUT_MS
  ) {
    this.sockPath = join(dataDir, 'osc-tap.sock')
    this._ports = ports
  }

  get ports(): PortConfig {
    return this._ports
  }

  /** Change ports and restart osc-tap with the new config. */
  setPorts(ports: PortConfig): void {
    const p = this._ports
    if (ports.listen === p.listen && ports.forward === p.forward && ports.beacon === p.beacon) {
      return
    }
    this._ports = ports
    this.restart()
  }

  private restart(): void {
    this.respawnDelay = RESPAWN_DELAY_MS
    this.dropConnection(new Error('osc-tap restarting'))
    if (this.mode === 'launchd') {
      this.bootstrapLaunchd()
      return
    }
    if (this.proc) {
      // The exit handler respawns with the updated args. This kill is
      // intentional — it must not count toward the crash-loop backoff.
      this.restarting = true
      this.proc.kill()
    } else {
      this.spawnTap()
    }
  }

  private tapArgs(): string[] {
    return [
      '--listen', String(this._ports.listen),
      '--forward', `127.0.0.1:${this._ports.forward}`,
      '--beacon', String(this._ports.beacon),
      '--outdir', this.outdir,
      '--control', this.sockPath
    ]
  }

  spawnTap(): void {
    if (this.mode === 'launchd') {
      this.bootstrapLaunchd()
      return
    }
    if (this.stopping || this.proc) return
    // Piped stdin + --exit-on-stdin-close: the tap exits if the editor dies hard.
    const proc = spawn(this.bin, [...this.tapArgs(), '--exit-on-stdin-close'], {
      stdio: ['pipe', 'ignore', 'pipe']
    })
    this.spawnedAt = Date.now()
    proc.stderr?.on('data', (d: Buffer) => console.log(`[osc-tap] ${d.toString().trimEnd()}`))
    proc.on('exit', (code, signal) => {
      this.proc = null
      this.dropConnection(new Error('osc-tap exited'))
      if (this.stopping) return
      if (this.restarting) {
        // Explicit restart (e.g. new ports): respawn now, keep the base delay.
        this.restarting = false
        this.respawnDelay = RESPAWN_DELAY_MS
        this.spawnTap()
        return
      }
      // Back off when the tap dies right after spawning (bad args, port in use…).
      const lived = Date.now() - this.spawnedAt
      this.respawnDelay =
        lived < 2000 ? Math.min(this.respawnDelay * 2, RESPAWN_DELAY_MAX_MS) : RESPAWN_DELAY_MS
      console.log(`osc-tap exited (${code ?? signal}), respawning in ${this.respawnDelay}ms`)
      setTimeout(() => this.spawnTap(), this.respawnDelay)
    })
    proc.on('error', (e) => {
      this.proc = null
      console.error(`osc-tap spawn failed: ${e.message}`)
    })
    this.proc = proc
  }

  shutdown(): void {
    this.stopping = true
    this.dropConnection(new Error('shutting down'))
    if (this.mode === 'launchd') {
      this.launchctl('bootout', `gui/${process.getuid!()}/${LAUNCHD_LABEL}`)
      // RunAtLoad=true: a surviving plist would bootstrap osc-tap at next
      // login with no editor running, orphaning the ports. Delete it.
      rmSync(this.plistPath(), { force: true })
      return
    }
    this.proc?.kill()
    this.proc = null
  }

  private plistPath(): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
  }

  /** Run launchctl; failures are logged, not thrown (bootout of a dead job etc.). */
  private launchctl(...args: string[]): boolean {
    try {
      execFileSync('launchctl', args, { stdio: 'ignore' })
      return true
    } catch {
      console.log(`launchctl ${args[0]} failed (may be fine)`)
      return false
    }
  }

  private bootstrapLaunchd(): void {
    const programArgs = [this.bin, ...this.tapArgs()]
      .map((a) => `      <string>${xmlEscape(a)}</string>`)
      .join('\n')
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(this.dataDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>1</integer>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(this.dataDir, 'osc-tap.log'))}</string>
  </dict>
</plist>
`
    mkdirSync(dirname(this.plistPath()), { recursive: true })
    writeFileSync(this.plistPath(), plist)
    const domain = `gui/${process.getuid!()}`
    // Replace any previous incarnation (other workdir/binary).
    this.launchctl('bootout', `${domain}/${LAUNCHD_LABEL}`)
    this.launchctl('bootout', `${domain}/${LEGACY_LAUNCHD_LABEL}`)
    rmSync(join(homedir(), 'Library', 'LaunchAgents', `${LEGACY_LAUNCHD_LABEL}.plist`), {
      force: true
    })
    if (!this.launchctl('bootstrap', domain, this.plistPath())) {
      console.error('launchctl bootstrap failed; osc-tap not running')
    }
  }

  /** Start recording, into `dir` instead of the default outdir when given. */
  async start(dir?: string): Promise<string> {
    const r = await this.request('start', dir ? { dir } : undefined)
    return r.clip as string
  }

  async stop(): Promise<void> {
    await this.request('stop')
  }

  async status(): Promise<TapStatus> {
    const r = await this.request('status')
    return r.status as unknown as TapStatus
  }

  /**
   * Long-poll loop over the tap's event log. Baselines on every connection —
   * `since` never survives a disconnect, because seq is per-process: a
   * restarted tap could otherwise replay old events or serve another epoch's
   * seqs as a continuation. Retries forever while the tap is down.
   */
  async runEventLoop(
    onEvent: (event: TapEvent) => void,
    onReset: (status: TapStatus) => void
  ): Promise<void> {
    let since: number | null = null
    let sinceGen = -1
    let backoff = WAIT_RETRY_MS
    while (!this.stopping) {
      if (sinceGen !== this.dropGen) since = null
      const gen = this.dropGen
      try {
        const r = (await this.request(
          'wait',
          since == null ? undefined : { since },
          WAIT_TIMEOUT_MS
        )) as unknown as TapWaitReply
        backoff = WAIT_RETRY_MS
        // Reply raced a disconnect: its seq may belong to a dead process.
        if (this.dropGen !== gen) continue
        if (r.reset && r.status) onReset(r.status)
        for (const e of r.events ?? []) onEvent(e)
        since = r.seq
        sinceGen = gen
      } catch {
        if (this.stopping) return
        await new Promise((res) => setTimeout(res, backoff))
        backoff = Math.min(backoff * 2, WAIT_RETRY_MAX_MS)
      }
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
          else reject(new Error(String(v.error ?? 'osc-tap error')))
        },
        reject: (e) => {
          clearTimeout(entry.timer)
          reject(e)
        },
        timer: setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`osc-tap ${cmd}: timed out`))
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
        console.error(`osc-tap: unparseable control reply: ${line}`)
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
    this.dropGen++
    this.sock?.destroy()
    this.sock = null
    this.buf = ''
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) p.reject(err)
  }
}
