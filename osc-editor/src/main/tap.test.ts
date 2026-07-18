import { mkdtempSync } from 'fs'
import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, expect, test, vi } from 'vitest'
import { DEFAULT_PORTS, type TapEvent, type TapStatus } from '../shared/types'
import { TapManager } from './tap'

/**
 * Fake osc-tap control server: newline-delimited JSON on a unix socket,
 * echoes the request id like the real one. `onRequest` decides when/what
 * to reply via the passed `reply` function.
 */
function fakeServer(
  sockPath: string,
  onRequest: (
    req: Record<string, unknown>,
    reply: (v: Record<string, unknown>) => void,
    nth: number,
    sock: net.Socket
  ) => void
): Promise<{ server: net.Server; connections: () => number }> {
  let connections = 0
  let nth = 0
  const server = net.createServer((sock) => {
    connections++
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString()
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        const req = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        onRequest(req, (v) => sock.write(JSON.stringify({ ...v, id: req.id }) + '\n'), nth++, sock)
      }
    })
    sock.on('error', () => {})
  })
  return new Promise((resolve) =>
    server.listen(sockPath, () => resolve({ server, connections: () => connections }))
  )
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const f of cleanups.splice(0)) f()
})

function setup(
  onRequest: Parameters<typeof fakeServer>[1]
): Promise<{ tap: TapManager; connections: () => number }> {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-tap-'))
  const tap = new TapManager('/nonexistent/osc-tap', dir, dir, 'child', DEFAULT_PORTS, 150)
  return fakeServer(tap.sockPath, onRequest).then(({ server, connections }) => {
    cleanups.push(() => {
      tap.shutdown()
      server.close()
    })
    return { tap, connections }
  })
}

test('a late reply to a timed-out request is not matched to the next request', async () => {
  const pending: ((v: Record<string, unknown>) => void)[] = []
  const { tap } = await setup((req, reply) => {
    if (req.cmd === 'status') {
      // Answer only when the next request arrives — after the client timeout.
      pending.push(reply)
    } else {
      // Stale status reply first, then the start reply.
      pending.splice(0).forEach((r) => r({ ok: true, status: { recording: false } }))
      reply({ ok: true, clip: '/clips/real.jsonl' })
    }
  })

  await expect(tap.status()).rejects.toThrow('timed out')
  await expect(tap.start()).resolves.toBe('/clips/real.jsonl')
})

test('concurrent requests during initial connect share one socket', async () => {
  const { tap, connections } = await setup((_req, reply) => {
    reply({ ok: true, status: { recording: false } })
  })

  const [a, b] = await Promise.all([tap.status(), tap.status()])
  expect(a).toEqual({ recording: false })
  expect(b).toEqual({ recording: false })
  expect(connections()).toBe(1)
})

const fakeStatus = { recording: false, last_clip: null } as unknown as TapStatus

test('wait loop: baseline on connect, events in order, re-baseline after reconnect', async () => {
  const events: TapEvent[] = []
  const resets: TapStatus[] = []
  const waits: { conn: number; since: number | undefined }[] = []
  const { tap, connections } = await setup((req, reply, _nth, sock) => {
    if (req.cmd !== 'wait') return
    const conn = connections()
    waits.push({ conn, since: req.since as number | undefined })
    if (req.since == null) {
      reply({ ok: true, seq: 5, events: [], reset: true, status: fakeStatus })
      return
    }
    if (conn === 1 && req.since === 5) {
      reply({
        ok: true,
        seq: 7,
        events: [
          { ev: 'rec_started', clip: '/c.jsonl' },
          { ev: 'rec_stopped', clip: '/c.jsonl' }
        ]
      })
      // Then drop the connection: the loop must re-baseline, not resume at 7
      // (a restarted tap's seqs are another epoch).
      setTimeout(() => sock.destroy(), 20)
    }
    // Anything else stays pending, like a server-side long poll.
  })

  void tap.runEventLoop(
    (e) => events.push(e),
    (s) => resets.push(s)
  )

  await vi.waitFor(() => expect(waits.some((w) => w.conn === 2)).toBe(true), { timeout: 5000 })

  expect(events).toEqual([
    { ev: 'rec_started', clip: '/c.jsonl' },
    { ev: 'rec_stopped', clip: '/c.jsonl' }
  ])
  // One reset per baseline (initial connect + reconnect).
  expect(resets.length).toBeGreaterThanOrEqual(2)
  expect(waits[0]).toEqual({ conn: 1, since: undefined })
  expect(waits[1]).toEqual({ conn: 1, since: 5 })
  // The new connection never reuses the dead connection's cursor.
  expect(waits.find((w) => w.conn === 2)?.since).toBeUndefined()
})

test('wait loop re-issues with the same cursor after an empty (timeout) reply', async () => {
  const waits: (number | undefined)[] = []
  const { tap } = await setup((req, reply) => {
    if (req.cmd !== 'wait') return
    waits.push(req.since as number | undefined)
    if (req.since == null) {
      reply({ ok: true, seq: 3, events: [], reset: true, status: fakeStatus })
    } else if (waits.length === 2) {
      // Server-side wait timeout: empty events, cursor unchanged.
      reply({ ok: true, seq: 3, events: [] })
    }
    // Third wait stays pending.
  })

  void tap.runEventLoop(
    () => {},
    () => {}
  )
  await vi.waitFor(() => expect(waits).toEqual([undefined, 3, 3]))
})
