import { mkdtempSync } from 'fs'
import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, expect, test } from 'vitest'
import { DEFAULT_PORTS } from '../shared/types'
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
    nth: number
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
        onRequest(req, (v) => sock.write(JSON.stringify({ ...v, id: req.id }) + '\n'), nth++)
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
  const dir = mkdtempSync(join(tmpdir(), 'osc-mtr-tap-'))
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
