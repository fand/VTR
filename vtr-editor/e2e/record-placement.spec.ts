import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'
import dgram from 'node:dgram'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 16410
const FORWARD_PORT = 16411

/** Pre-made clip that owns 0..5s on the tracks a test wants occupied. */
const BUSY = 'busy.jsonl'

function pad4(b: Buffer): Buffer {
  return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
}

/** Minimal OSC message encoder (float args only). */
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

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

interface Launched {
  app: ElectronApplication
  page: Page
}

/** One track per entry; true = the track already holds a clip over 0..5s. */
async function launchApp(occupied: boolean[]): Promise<Launched> {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, BUSY),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 1, port: LISTEN_PORT, a: '/busy', args: [0.5] },
      { type: 'session_end', t: 5 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 30,
      tracks: occupied.map((busy) => ({
        clips: busy ? [{ file: BUSY, offset: 0, trimIn: 0, trimOut: 5 }] : []
      }))
    })
  )
  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js'), join(workdir, 'project.json')],
    cwd: workdir,
    env: {
      ...process.env,
      VTR_TAP_BIN: join(__dirname, '../../target/debug/vtr-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir
    }
  })
  const page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  await expect(page.locator('.track')).toHaveCount(occupied.length)
  return { app, page }
}

/**
 * Record a short take. No /vtr/clock beacon, so the clip carries no tl and
 * lands at the playhead — 0 here, right on top of the busy clips.
 */
async function record(page: Page, sock: dgram.Socket): Promise<void> {
  await page.getByRole('button', { name: 'Rec' }).click()
  for (let i = 0; i < 5; i++) {
    sock.send(oscMessage('/take', [i / 5]), LISTEN_PORT, '127.0.0.1')
    await sleep(100)
  }
  await page.getByRole('button', { name: 'Stop' }).click()
}

/** The recorded clip, told apart from the pre-made busy ones by name. */
function recorded(page: Page): ReturnType<Page['locator']> {
  return page.locator('.clip:not(.recording)').filter({ hasNotText: 'busy' })
}

test('record: the take lands on the selected track when the span is free', async () => {
  const { app, page } = await launchApp([false, false, false])
  const sock = dgram.createSocket('udp4')
  try {
    await page.locator('.track .track-label').nth(2).click()
    await expect(page.locator('.track-label.selected')).toHaveCount(1)

    await record(page, sock)

    // Track 3, not the first free one — and no track was added.
    await expect(recorded(page)).toHaveCount(1)
    await expect(page.locator('.track')).toHaveCount(3)
    await expect(page.locator('.track').nth(2).locator('.clip')).toHaveCount(1)
    await expect(page.locator('.track').nth(0).locator('.clip')).toHaveCount(0)
    await expect(page.locator('.track').nth(1).locator('.clip')).toHaveCount(0)
    await expect(page.locator('.sb-log')).toContainText('→ track 3')
  } finally {
    sock.close()
    await app.close()
  }
})

test('record: without a selection the take takes the topmost free track', async () => {
  const { app, page } = await launchApp([true, false, false])
  const sock = dgram.createSocket('udp4')
  try {
    // Nothing selected: the search starts at the top of the stack.
    await expect(page.locator('.track-label.selected')).toHaveCount(0)

    await record(page, sock)

    // Track 1 is busy, so track 2 wins — not track 3, not a new track.
    await expect(recorded(page)).toHaveCount(1)
    await expect(page.locator('.track')).toHaveCount(3)
    await expect(page.locator('.track').nth(1).locator('.clip')).toHaveCount(1)
    await expect(page.locator('.track').nth(1).locator('.clip')).not.toContainText('busy')
    await expect(page.locator('.track').nth(2).locator('.clip')).toHaveCount(0)
    await expect(page.locator('.sb-log')).toContainText('→ track 2')
  } finally {
    sock.close()
    await app.close()
  }
})

test('record: an occupied selected track pushes the take one track down', async () => {
  const { app, page } = await launchApp([true, false])
  const sock = dgram.createSocket('udp4')
  try {
    await page.locator('.track .track-label').nth(0).click()
    await expect(page.locator('.track-label.selected')).toHaveCount(1)

    await record(page, sock)

    // Track 1 keeps only the busy clip; the take goes to track 2.
    await expect(recorded(page)).toHaveCount(1)
    await expect(page.locator('.track')).toHaveCount(2)
    await expect(page.locator('.track').nth(0).locator('.clip')).toHaveCount(1)
    await expect(page.locator('.track').nth(1).locator('.clip')).toHaveCount(1)
    await expect(page.locator('.track').nth(1).locator('.clip')).not.toContainText('busy')
    await expect(page.locator('.sb-log')).toContainText('→ track 2')
  } finally {
    sock.close()
    await app.close()
  }
})

test('record: no room below the selected track grows a new one', async () => {
  const { app, page } = await launchApp([true, true])
  const sock = dgram.createSocket('udp4')
  try {
    await page.locator('.track .track-label').nth(0).click()
    await expect(page.locator('.track-label.selected')).toHaveCount(1)

    await record(page, sock)

    await expect(page.locator('.track')).toHaveCount(3)
    await expect(recorded(page)).toHaveCount(1)
    await expect(page.locator('.track').nth(2).locator('.clip')).toHaveCount(1)
    await expect(page.locator('.track').nth(2).locator('.clip')).not.toContainText('busy')
    await expect(page.locator('.sb-log')).toContainText('→ new track')
  } finally {
    sock.close()
    await app.close()
  }
})
