import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'
import dgram from 'node:dgram'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance never collides.
const LISTEN_PORT = 14110
const TD_PORT = 14111
const BEACON_PORT = 14112

function pad4(b: Buffer): Buffer {
  return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
}

function oscMessage(addr: string, floats: number[]): Buffer {
  const addrB = pad4(Buffer.from(addr + '\0'))
  const tagsB = pad4(Buffer.from(',' + 'f'.repeat(floats.length) + '\0'))
  const argsB = Buffer.alloc(4 * floats.length)
  floats.forEach((f, i) => argsB.writeFloatBE(f, i * 4))
  return Buffer.concat([addrB, tagsB, argsB])
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page; workdir: string }> {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: TD_PORT, beacon: BEACON_PORT },
      tracks: []
    })
  )
  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js'), join(workdir, 'project.json')],
    cwd: workdir,
    env: {
      ...process.env,
      OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir
    }
  })
  const page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  return { app, page, workdir }
}

async function recordClip(page: Page, sock: dgram.Socket, n: number): Promise<void> {
  await page.getByRole('button', { name: 'Rec' }).click()
  for (let i = 0; i < n; i++) {
    sock.send(oscMessage('/fader', [i / n]), LISTEN_PORT, '127.0.0.1')
    await sleep(100)
  }
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.clip:not(.recording)')).toHaveCount(1)
}

test('export writes merged session.jsonl', async () => {
  const { app, page, workdir } = await launchApp()
  const sock = dgram.createSocket('udp4')
  try {
    await recordClip(page, sock, 10)
    await page.getByRole('button', { name: 'File' }).click()
    await page.getByRole('button', { name: 'Export' }).click()
    await expect(page.locator('.sb-log')).toContainText('Exported')

    const lines = readFileSync(join(workdir, 'session.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(lines[0].type).toBe('session_start')
    expect(lines[lines.length - 1].type).toBe('session_end')
    const events = lines.slice(1, -1)
    expect(events).toHaveLength(10)
    expect(events[0].a).toBe('/fader')
    expect(events[0].t).toBeGreaterThanOrEqual(0)
    const ts = events.map((e: { t: number }) => e.t)
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
    expect(lines[lines.length - 1].t).toBeGreaterThanOrEqual(ts[ts.length - 1])
  } finally {
    sock.close()
    await app.close()
  }
})

test('pause keeps the playhead where playback stopped; play resumes from it', async () => {
  const { app, page } = await launchApp()
  const sock = dgram.createSocket('udp4')
  try {
    await recordClip(page, sock, 8) // ~0.7s span
    await page.getByLabel('timeline duration').fill('30')
    await page.getByLabel('timeline duration').press('Enter')

    // Playhead x at default zoom: LABEL_W (96) + sec * 20px/s.
    const playheadLeft = (): Promise<number> =>
      page.locator('.playhead').evaluate((el) => parseFloat((el as HTMLElement).style.left))

    await page.getByRole('button', { name: 'Play' }).click()
    await sleep(600)
    await page.getByRole('button', { name: 'Pause' }).click()
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
    const pausedAt = await playheadLeft()
    // ~0.6s in: the playhead stayed there instead of snapping back to 0.
    expect(pausedAt).toBeGreaterThan(96 + 6)
    await sleep(300) // paused: it must not creep
    expect(await playheadLeft()).toBeCloseTo(pausedAt, 1)

    // Resume: playback continues from the paused position.
    await page.getByRole('button', { name: 'Play' }).click()
    await sleep(500)
    await page.getByRole('button', { name: 'Pause' }).click()
    expect(await playheadLeft()).toBeGreaterThan(pausedAt + 4)
  } finally {
    sock.close()
    await app.close()
  }
})

test('preview replays events to TD port with original spacing', async () => {
  const { app, page } = await launchApp()
  const sock = dgram.createSocket('udp4')
  // Stand-in TD: collect datagrams with arrival times.
  const td = dgram.createSocket('udp4')
  const received: { at: number; addr: string }[] = []
  let collecting = false
  td.on('message', (msg) => {
    if (collecting) received.push({ at: Date.now(), addr: msg.toString('ascii', 0, 6) })
  })
  await new Promise<void>((r) => td.bind(TD_PORT, '127.0.0.1', r))
  try {
    await recordClip(page, sock, 10) // ~0.9s span
    // Playback runs to the timeline end; keep it short so auto-stop happens fast.
    await page.getByLabel('timeline duration').fill('2')
    await page.getByLabel('timeline duration').press('Enter')
    // Space in a focused field must not toggle playback.
    await page.getByLabel('timeline duration').click()
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
    await page.keyboard.press('Enter') // blur; the space-only draft reverts to 2
    collecting = true
    await page.getByRole('button', { name: 'Play' }).click()
    await sleep(2800) // playback (2s timeline) + margin
    expect(received.length).toBe(10)
    const span = received[received.length - 1].at - received[0].at
    expect(span).toBeGreaterThan(700)
    expect(span).toBeLessThan(1400)
    expect(received[0].addr).toContain('/fader')
    // Auto-stopped at the end.
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
  } finally {
    td.close()
    sock.close()
    await app.close()
  }
})
