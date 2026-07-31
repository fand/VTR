import { mkdtempSync } from 'fs'
import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, expect, test, vi } from 'vitest'
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
    '',
    join(dir, 'vtr-tap.sock'),
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

test('echo target change drops the connection; same target is a no-op', async () => {
  const { player, connections } = await setup((_req, reply) => {
    reply({ ok: true, status: fakeStatus })
  })
  await player.status()
  expect(connections()).toBe(1)

  player.setEcho(9000, '') // unchanged: keep the connection
  await player.status()
  expect(connections()).toBe(1)

  player.setEcho(9001, '') // restart: reconnects on the next request
  await player.status()
  expect(connections()).toBe(2)

  player.setEcho(9001, '10.0.1.5') // host alone is enough to restart
  await player.status()
  expect(connections()).toBe(3)
})

test('preview sync methods send the control cmds', async () => {
  const seen: Record<string, unknown>[] = []
  const { player } = await setup((req, reply) => {
    seen.push(req)
    reply({ ok: true })
  })
  const events = [{ t: 0.5, port: 10010, a: '/x', types: 'f', args: [0.1] }]
  await player.loadInline(events, [], 12.5, { '10010': 10011 })
  await player.seek(2.5)
  await player.play()
  await player.stopTransport()

  expect(seen.map((r) => r.cmd)).toEqual(['load', 'seek', 'play', 'stop'])
  expect(seen[0]).toMatchObject({
    cmd: 'load',
    events,
    duration: 12.5,
    routes: { '10010': 10011 },
    name: '(editor)',
    origin: 'editor',
    keep: true
  })
  expect(seen[0]).not.toHaveProperty('path')
  expect(seen[1]).toMatchObject({ cmd: 'seek', t: 2.5 })
})

test('transport commands return the reply snapshot', async () => {
  const { player } = await setup((req, reply) => {
    if (req.cmd === 'seek')
      reply({ ok: true, playing: false, playhead: 2.5, gen: 3, origin: 'editor' })
    else if (req.cmd === 'play')
      reply({ ok: true, playing: true, playhead: 2.5, gen: 4, origin: 'editor' })
    else reply({ ok: true, playing: false, playhead: 6.75, gen: 5, origin: 'editor' })
  })
  await expect(player.seek(2.5)).resolves.toEqual({
    gen: 3,
    origin: 'editor',
    playhead: 2.5,
    playing: false
  })
  await expect(player.play()).resolves.toMatchObject({ playing: true, gen: 4 })
  await expect(player.stopTransport()).resolves.toMatchObject({ playhead: 6.75, playing: false })
})

test('spawn re-pushes the last inline load (a respawned player is empty)', async () => {
  const seen: Record<string, unknown>[] = []
  const { player } = await setup((req, reply) => {
    seen.push(req)
    reply({ ok: true })
  })
  const events = [{ t: 0.5, port: 10010, a: '/x', types: 'f', args: [0.1] }]
  await player.loadInline(events, [], 5, { '10010': 10011 })
  player.spawnPlayer() // respawn path; the fake server stands in for the new player
  await vi.waitFor(() => expect(seen.filter((r) => r.cmd === 'load')).toHaveLength(2))
  expect(seen[1]).toMatchObject({ cmd: 'load', events, duration: 5, keep: true })
})

test('transport writes carry the editor origin', async () => {
  const seen: Record<string, unknown>[] = []
  const { player } = await setup((req, reply) => {
    seen.push(req)
    reply({ ok: true })
  })
  await player.seek(1.5)
  await player.play()
  await player.stopTransport()
  expect(seen).toMatchObject([
    { cmd: 'seek', t: 1.5, origin: 'editor' },
    { cmd: 'play', origin: 'editor' },
    { cmd: 'stop', origin: 'editor' }
  ])
})

test('watch parses the transport snapshot', async () => {
  const { player } = await setup((req, reply) => {
    if (req.cmd === 'watch') {
      expect(req.gen).toBe(7)
      reply({ ok: true, gen: 8, origin: 'td', playhead: 3.25, playing: true })
    }
  })
  await expect(player.watch(7)).resolves.toEqual({
    gen: 8,
    origin: 'td',
    playhead: 3.25,
    playing: true
  })
})

test('a pending watch shares the command connection and never delays it', async () => {
  // vtr-player answers a watch from its own thread, so the seek reply comes
  // back first on the same socket. Matching by id is what makes that work.
  const watchReplies: ((v: Record<string, unknown>) => void)[] = []
  const { player, connections } = await setup((req, reply) => {
    if (req.cmd === 'watch')
      watchReplies.push(reply) // hold: simulate the long-poll blocking
    else reply({ ok: true })
  })
  const watching = player.watch(0)
  await new Promise((r) => setTimeout(r, 20)) // let the watch land server-side
  await player.seek(1.0) // must resolve while the watch is still pending
  expect(connections()).toBe(1)
  watchReplies[0]({ ok: true, gen: 1, origin: 'osc', playhead: 1.0, playing: false })
  await expect(watching).resolves.toMatchObject({ gen: 1, origin: 'osc' })
})
