import { mkdtempSync } from 'fs'
import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, expect, test } from 'vitest'
import { PlayerManager } from './player'

/** Fake vtr-player control server, like tap.test.ts's. */
function fakeServer(
  sockPath: string,
  onRequest: (req: Record<string, unknown>, reply: (v: Record<string, unknown>) => void) => void
): Promise<{ server: net.Server; connections: () => number }> {
  let connections = 0
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
        onRequest(req, (v) => sock.write(JSON.stringify({ ...v, id: req.id }) + '\n'))
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
): Promise<{ player: PlayerManager; connections: () => number }> {
  const dir = mkdtempSync(join(tmpdir(), 'vtr-player-'))
  const player = new PlayerManager(
    '/nonexistent/vtr-player',
    dir,
    9000,
    join(dir, 'osc-tap.sock'),
    150
  )
  return fakeServer(player.sockPath, onRequest).then(({ server, connections }) => {
    cleanups.push(() => {
      player.shutdown()
      server.close()
    })
    return { player, connections }
  })
}

const fakeStatus = { loaded: null, playing: false, playhead: 0, connections: 1 }

test('status round-trips through the control socket', async () => {
  const { player } = await setup((req, reply) => {
    if (req.cmd === 'status') reply({ ok: true, status: fakeStatus })
  })
  await expect(player.status()).resolves.toEqual(fakeStatus)
})

test('an error reply rejects', async () => {
  const { player } = await setup((_req, reply) => {
    reply({ ok: false, error: 'nope' })
  })
  await expect(player.status()).rejects.toThrow('nope')
})

test('concurrent requests during initial connect share one socket', async () => {
  const { player, connections } = await setup((_req, reply) => {
    reply({ ok: true, status: fakeStatus })
  })
  await Promise.all([player.status(), player.status()])
  expect(connections()).toBe(1)
})

test('echo port change drops the connection; same port is a no-op', async () => {
  const { player, connections } = await setup((_req, reply) => {
    reply({ ok: true, status: fakeStatus })
  })
  await player.status()
  expect(connections()).toBe(1)

  player.setEchoPort(9000) // unchanged: keep the connection
  await player.status()
  expect(connections()).toBe(1)

  player.setEchoPort(9001) // restart: reconnects on the next request
  await player.status()
  expect(connections()).toBe(2)
})

test('preview sync methods send the control cmds', async () => {
  const seen: Record<string, unknown>[] = []
  const { player } = await setup((req, reply) => {
    seen.push(req)
    reply({ ok: true })
  })
  const events = [{ t: 0.5, port: 10010, a: '/x', types: 'f', args: [0.1] }]
  await player.loadInline(events, 12.5)
  await player.seek(2.5)
  await player.play()
  await player.stopTransport()

  expect(seen.map((r) => r.cmd)).toEqual(['load', 'seek', 'play', 'stop'])
  expect(seen[0]).toMatchObject({ cmd: 'load', events, duration: 12.5, name: '(editor)' })
  expect(seen[0]).not.toHaveProperty('path')
  expect(seen[0]).not.toHaveProperty('routes')
  expect(seen[1]).toMatchObject({ cmd: 'seek', t: 2.5 })
})
