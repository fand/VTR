import net from 'net'

const CONNECT_DEADLINE_MS = 5000

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/**
 * One unix-socket control connection with id-matched request/reply framing
 * (JSON Lines, one response per request line), shared by the tap and player
 * managers. The servers handle each connection's lines strictly in order, so
 * a blocking long-poll head-of-line-delays every other request on the same
 * socket — callers that long-poll keep a dedicated channel for it.
 */
export class ControlChannel {
  private sock: net.Socket | null = null
  private connecting: Promise<net.Socket> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buf = ''

  constructor(
    private sockPath: string,
    /** Error-message prefix, e.g. 'vtr-tap'. */
    private name: string,
    /** Runs first on every drop, before pending requests reject. */
    private onDrop?: () => void
  ) {}

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
          else reject(new Error(String(v.error ?? `${this.name} error`)))
        },
        reject: (e) => {
          clearTimeout(entry.timer)
          reject(e)
        },
        timer: setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`${this.name} ${cmd}: timed out`))
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      sock.write(JSON.stringify({ id, cmd, ...extra }) + '\n')
    })
  }

  drop(err: Error): void {
    this.onDrop?.()
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
        console.error(`${this.name}: unparseable control reply: ${line}`)
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
