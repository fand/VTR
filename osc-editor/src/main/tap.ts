import { ChildProcess, spawn } from 'child_process'
import net from 'net'
import { join } from 'path'
import type { TapStatus } from '../shared/types'

const REQUEST_TIMEOUT_MS = 3000
const CONNECT_DEADLINE_MS = 5000
const RESPAWN_DELAY_MS = 1000

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

  constructor(
    private bin: string,
    readonly workdir: string
  ) {
    this.sockPath = join(workdir, 'osc-tap.sock')
  }

  spawnTap(): void {
    if (this.stopping || this.proc) return
    const proc = spawn(
      this.bin,
      [
        '--listen', '10010',
        '--forward', '127.0.0.1:10011',
        '--beacon', '10012',
        '--outdir', this.workdir,
        '--control', this.sockPath
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    proc.stderr?.on('data', (d: Buffer) => console.log(`[osc-tap] ${d.toString().trimEnd()}`))
    proc.on('exit', (code, signal) => {
      this.proc = null
      this.dropConnection(new Error('osc-tap exited'))
      if (!this.stopping) {
        console.log(`osc-tap exited (${code ?? signal}), respawning in ${RESPAWN_DELAY_MS}ms`)
        setTimeout(() => this.spawnTap(), RESPAWN_DELAY_MS)
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
    this.proc?.kill()
    this.proc = null
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
