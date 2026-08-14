import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  DEFAULT_PORTS,
  RELAY_PORT,
  type MonitorLine,
  type PortConfig,
  type TapEvent,
  type TapMonitorReply,
  type TapStatus,
  type TapWaitReply
} from '../shared/types'
import { ControlChannel } from './controlChannel'
import { ChildSupervisor } from './supervisor'

const REQUEST_TIMEOUT_MS = 3000
/** Above the tap's 25s server-side wait timeout: quiet waits return empty. */
const WAIT_TIMEOUT_MS = 30_000
const WAIT_RETRY_MS = 500
const WAIT_RETRY_MAX_MS = 5000
/** Pause between monitor polls: batches high-rate traffic into ≤20 pushes/s. */
const MONITOR_INTERVAL_MS = 50

/**
 * child: vtr-tap is our child process; we respawn it on crash.
 * launchd: vtr-tap runs as a launchd user agent (KeepAlive on crash);
 *          survives an editor crash, bootout on clean editor exit.
 */
export type SpawnMode = 'child' | 'launchd'

const LAUNCHD_LABEL = 'com.fand.vtr.vtr-tap'
// Pre-rename labels; a RunAtLoad plist would keep an orphan tap on the ports.
const LEGACY_LAUNCHD_LABELS = ['com.fand.vtr.osc-tap', 'com.osc-mtr.osc-tap']

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Spawns vtr-tap (via ChildSupervisor, or launchd), and talks to its unix
 * socket control API over a ControlChannel.
 */
export class TapManager {
  readonly sockPath: string
  private chan: ControlChannel
  private child: ChildSupervisor
  private stopping = false
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
    this.sockPath = join(dataDir, 'vtr-tap.sock')
    this._ports = ports
    this.chan = new ControlChannel(this.sockPath, 'vtr-tap', () => {
      this.dropGen++
    })
    this.child = new ChildSupervisor({
      label: 'vtr-tap',
      bin: this.bin,
      args: () => this.tapArgs(),
      onExit: (err) => this.chan.drop(err)
    })
  }

  get ports(): PortConfig {
    return this._ports
  }

  /** Change ports and restart vtr-tap when its own config changed (the
   *  echo port belongs to vtr-player, not the tap). */
  setPorts(ports: PortConfig): void {
    const p = this._ports
    const restart = ports.listen !== p.listen || ports.forward !== p.forward
    this._ports = ports
    if (restart) this.restart()
  }

  private restart(): void {
    this.chan.drop(new Error('vtr-tap restarting'))
    if (this.mode === 'launchd') {
      this.bootstrapLaunchd()
      return
    }
    this.child.restart()
  }

  private tapArgs(): string[] {
    return [
      '--listen',
      String(this._ports.listen),
      '--forward',
      `127.0.0.1:${this._ports.forward}`,
      '--relay',
      `127.0.0.1:${RELAY_PORT}`,
      '--outdir',
      this.outdir,
      '--control',
      this.sockPath
    ]
  }

  spawnTap(): void {
    if (this.mode === 'launchd') {
      this.bootstrapLaunchd()
      return
    }
    if (this.stopping) return
    this.child.spawn()
  }

  shutdown(): void {
    this.stopping = true
    this.chan.drop(new Error('shutting down'))
    if (this.mode === 'launchd') {
      this.launchctl('bootout', `gui/${process.getuid!()}/${LAUNCHD_LABEL}`)
      // RunAtLoad=true: a surviving plist would bootstrap vtr-tap at next
      // login with no editor running, orphaning the ports. Delete it.
      rmSync(this.plistPath(), { force: true })
      return
    }
    this.child.shutdown()
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
    <string>${xmlEscape(join(this.dataDir, 'vtr-tap.log'))}</string>
  </dict>
</plist>
`
    mkdirSync(dirname(this.plistPath()), { recursive: true })
    writeFileSync(this.plistPath(), plist)
    const domain = `gui/${process.getuid!()}`
    // Replace any previous incarnation (other workdir/binary).
    this.launchctl('bootout', `${domain}/${LAUNCHD_LABEL}`)
    for (const legacy of LEGACY_LAUNCHD_LABELS) {
      this.launchctl('bootout', `${domain}/${legacy}`)
      rmSync(join(homedir(), 'Library', 'LaunchAgents', `${legacy}.plist`), { force: true })
    }
    if (!this.launchctl('bootstrap', domain, this.plistPath())) {
      console.error('launchctl bootstrap failed; vtr-tap not running')
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

  /**
   * Long-poll loop over the tap's live OSC monitor. Same cursor rules as
   * runEventLoop; a reset just re-baselines (missed lines are not
   * recoverable and the log view tolerates gaps). Polling is what turns
   * monitor capture on tap-side.
   */
  async runMonitorLoop(onLines: (lines: MonitorLine[]) => void): Promise<void> {
    let since: number | null = null
    let sinceGen = -1
    let backoff = WAIT_RETRY_MS
    while (!this.stopping) {
      if (sinceGen !== this.dropGen) since = null
      const gen = this.dropGen
      try {
        const r = (await this.request(
          'monitor',
          since == null ? undefined : { since },
          WAIT_TIMEOUT_MS
        )) as unknown as TapMonitorReply
        backoff = WAIT_RETRY_MS
        // Reply raced a disconnect: its seq may belong to a dead process.
        if (this.dropGen !== gen) continue
        if (r.lines && r.lines.length > 0) onLines(r.lines)
        since = r.seq
        sinceGen = gen
        await new Promise((res) => setTimeout(res, MONITOR_INTERVAL_MS))
      } catch {
        if (this.stopping) return
        await new Promise((res) => setTimeout(res, backoff))
        backoff = Math.min(backoff * 2, WAIT_RETRY_MAX_MS)
      }
    }
  }

  private request(
    cmd: string,
    extra?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<Record<string, unknown>> {
    return this.chan.request(cmd, extra, timeoutMs)
  }
}
