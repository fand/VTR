import { ChildProcess, execFileSync, spawn } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import net from 'net'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { DEFAULT_PORTS, type PortConfig, type TapStatus } from '../shared/types'

const REQUEST_TIMEOUT_MS = 3000
const CONNECT_DEADLINE_MS = 5000
const RESPAWN_DELAY_MS = 1000
const RESPAWN_DELAY_MAX_MS = 10_000

/**
 * child: osc-tap is our child process; we respawn it on crash.
 * launchd: osc-tap runs as a launchd user agent (KeepAlive on crash);
 *          survives an editor crash, bootout on clean editor exit.
 */
export type SpawnMode = 'child' | 'launchd'

const LAUNCHD_LABEL = 'com.osc-mtr.osc-tap'

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
  private pending: Pending[] = []
  private buf = ''
  private stopping = false
  private respawnDelay = RESPAWN_DELAY_MS
  private spawnedAt = 0

  private _ports: PortConfig

  constructor(
    private bin: string,
    readonly workdir: string,
    private mode: SpawnMode = 'child',
    ports: PortConfig = DEFAULT_PORTS
  ) {
    this.sockPath = join(workdir, 'osc-tap.sock')
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
      // The exit handler respawns with the updated args.
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
      '--outdir', this.workdir,
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
      if (!this.stopping) {
        // Back off when the tap dies right after spawning (bad args, port in use…).
        const lived = Date.now() - this.spawnedAt
        this.respawnDelay =
          lived < 2000 ? Math.min(this.respawnDelay * 2, RESPAWN_DELAY_MAX_MS) : RESPAWN_DELAY_MS
        console.log(`osc-tap exited (${code ?? signal}), respawning in ${this.respawnDelay}ms`)
        setTimeout(() => this.spawnTap(), this.respawnDelay)
      }
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
    <string>${xmlEscape(this.workdir)}</string>
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
    <string>${xmlEscape(join(this.workdir, 'osc-tap.log'))}</string>
  </dict>
</plist>
`
    mkdirSync(dirname(this.plistPath()), { recursive: true })
    writeFileSync(this.plistPath(), plist)
    const domain = `gui/${process.getuid!()}`
    // Replace any previous incarnation (other workdir/binary).
    this.launchctl('bootout', `${domain}/${LAUNCHD_LABEL}`)
    if (!this.launchctl('bootstrap', domain, this.plistPath())) {
      console.error('launchctl bootstrap failed; osc-tap not running')
    }
  }

  async start(): Promise<string> {
    const r = await this.request('start')
    return r.clip as string
  }

  async stop(): Promise<void> {
    await this.request('stop')
  }

  async status(): Promise<TapStatus> {
    const r = await this.request('status')
    return r.status as unknown as TapStatus
  }

  private async request(cmd: string): Promise<Record<string, unknown>> {
    const sock = await this.connect()
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
          this.pending = this.pending.filter((p) => p !== entry)
          reject(new Error(`osc-tap ${cmd}: timed out`))
        }, REQUEST_TIMEOUT_MS)
      }
      this.pending.push(entry)
      sock.write(JSON.stringify({ cmd }) + '\n')
    })
  }

  private async connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return this.sock
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
      const entry = this.pending.shift()
      if (!entry) continue
      try {
        entry.resolve(JSON.parse(line))
      } catch (e) {
        entry.reject(e as Error)
      }
    }
  }

  private dropConnection(err: Error): void {
    this.sock?.destroy()
    this.sock = null
    this.buf = ''
    const pending = this.pending
    this.pending = []
    for (const p of pending) p.reject(err)
  }
}
