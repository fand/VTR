import { ChildProcess, spawn } from 'child_process'

const RESPAWN_DELAY_MS = 1000
const RESPAWN_DELAY_MAX_MS = 10_000

/**
 * Spawns one of our Rust binaries as a child process and respawns it on
 * crash, backing off when it dies right after spawning (bad args, port in
 * use…). Shared by the tap and player managers; the tap's launchd mode
 * bypasses this entirely.
 */
export class ChildSupervisor {
  private proc: ChildProcess | null = null
  private stopping = false
  private restarting = false
  private respawnDelay = RESPAWN_DELAY_MS
  private spawnedAt = 0

  constructor(
    private opts: {
      /** Log prefix and death messages, e.g. 'vtr-tap'. */
      label: string
      bin: string
      /** Re-read on every (re)spawn so restarts pick up new config. */
      args: () => string[]
      /** Runs on every death, before any respawn (drop the control connection). */
      onExit: (err: Error) => void
      /** Runs after every successful spawn call (e.g. re-push resident state). */
      onSpawned?: () => void
    }
  ) {}

  spawn(): void {
    if (this.stopping || this.proc) return
    // Piped stdin + --exit-on-stdin-close: the child exits if the editor dies hard.
    const proc = spawn(this.opts.bin, [...this.opts.args(), '--exit-on-stdin-close'], {
      stdio: ['pipe', 'ignore', 'pipe']
    })
    this.spawnedAt = Date.now()
    proc.stderr?.on('data', (d: Buffer) =>
      console.log(`[${this.opts.label}] ${d.toString().trimEnd()}`)
    )
    // 'error' fires instead of 'exit' when the spawn itself fails (binary
    // missing mid-rebuild, EAGAIN…) and may fire alongside it; both funnel
    // into one guarded handler so every death drops the connection and
    // respawns exactly once.
    let dead = false
    const died = (why: string): void => {
      if (dead) return
      dead = true
      this.proc = null
      this.opts.onExit(new Error(`${this.opts.label} exited`))
      if (this.stopping) return
      if (this.restarting) {
        // Explicit restart (e.g. new config): respawn now, keep the base delay.
        this.restarting = false
        this.respawnDelay = RESPAWN_DELAY_MS
        this.spawn()
        return
      }
      const lived = Date.now() - this.spawnedAt
      this.respawnDelay =
        lived < 2000 ? Math.min(this.respawnDelay * 2, RESPAWN_DELAY_MAX_MS) : RESPAWN_DELAY_MS
      console.log(`${why}, respawning in ${this.respawnDelay}ms`)
      setTimeout(() => this.spawn(), this.respawnDelay)
    }
    proc.on('exit', (code, signal) => died(`${this.opts.label} exited (${code ?? signal})`))
    proc.on('error', (e) => died(`${this.opts.label} spawn failed: ${e.message}`))
    this.proc = proc
    this.opts.onSpawned?.()
  }

  /** Kill + immediate respawn with fresh args; not counted as a crash. */
  restart(): void {
    this.respawnDelay = RESPAWN_DELAY_MS
    if (this.proc) {
      this.restarting = true
      this.proc.kill()
    } else {
      this.spawn()
    }
  }

  shutdown(): void {
    this.stopping = true
    this.proc?.kill()
    this.proc = null
  }
}
