import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'
import dgram from 'node:dgram'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14010
const FORWARD_PORT = 14011
const BEACON_PORT = 14012

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

interface Launched {
  app: ElectronApplication
  page: Page
  workdir: string
}

async function launchApp(): Promise<Launched> {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
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
  app.process().stdout?.on('data', (d) => console.log(`[main] ${d.toString().trimEnd()}`))
  app.process().stderr?.on('data', (d) => console.log(`[main!] ${d.toString().trimEnd()}`))
  const page = await app.firstWindow()
  page.on('console', (msg) => console.log(`[renderer] ${msg.text()}`))
  await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
  return { app, page, workdir }
}

function readProject(workdir: string): { tracks: { clips: Record<string, number>[] }[] } {
  return JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8'))
}

/** Explicit save (Cmd+S); the app no longer autosaves. */
function save(page: Page): Promise<void> {
  return page.keyboard.press('ControlOrMeta+s')
}

test('record → clip on track → drag → delete → persisted', async () => {
  const { app, page, workdir } = await launchApp()
  const sock = dgram.createSocket('udp4')
  try {
    await page.getByRole('button', { name: 'Rec' }).click()
    for (let i = 0; i < 15; i++) {
      sock.send(oscMessage('/fader', [i / 15]), LISTEN_PORT, '127.0.0.1')
      await sleep(150)
    }
    await page.getByRole('button', { name: 'Stop' }).click()

    const clip = page.locator('.clip:not(.recording)')
    await expect(clip).toHaveCount(1)
    await expect(page.locator('.clip-meta')).toContainText('15 ev')

    // Header stats: the rx rate chip is live and nothing was dropped, so
    // the clip carries no data-loss warning.
    await expect(page.locator('.chip', { hasText: /^rx / })).toBeVisible()
    await expect(page.locator('.chip', { hasText: 'dropped 0' })).toBeVisible()
    await expect(clip).not.toHaveClass(/warn/)

    // The new clip marks the project edited; save clears the suffix.
    await expect.poll(() => page.title()).toBe('VTR - project.json (edited)')
    // macOS proxy icon carries the full path + the native edited dot.
    if (process.platform === 'darwin') {
      const winState = (): Promise<{ file: string; edited: boolean }> =>
        app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          return { file: win.getRepresentedFilename(), edited: win.isDocumentEdited() }
        })
      await expect.poll(winState).toEqual({ file: join(workdir, 'project.json'), edited: true })
      await save(page)
      await expect.poll(winState).toEqual({ file: join(workdir, 'project.json'), edited: false })
    } else {
      await save(page)
    }
    await expect.poll(() => page.title()).toBe('VTR - project.json')
    await expect.poll(() => readProject(workdir).tracks.length).toBe(1)
    expect(readProject(workdir).tracks[0].clips[0].offset).toBe(0)

    // Drag right by 100px = +5s at 20px/s.
    const box = (await clip.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
    await save(page)
    await expect.poll(() => readProject(workdir).tracks[0].clips[0].offset).toBeGreaterThan(4)
    expect(readProject(workdir).tracks[0].clips[0].offset).toBeLessThan(6)

    // Delete the selected clip; the (now empty) track stays.
    await clip.click()
    await page.keyboard.press('Delete')
    await expect(page.locator('.clip')).toHaveCount(0)
    await expect(page.locator('.track')).toHaveCount(1)
    await save(page)
    await expect.poll(() => readProject(workdir).tracks[0].clips.length).toBe(0)
    expect(readProject(workdir).tracks).toHaveLength(1)
  } finally {
    sock.close()
    await app.close()
  }
})

test('beacon → tl recorded → clip auto-aligned at record stop', async () => {
  const { app, page } = await launchApp()
  const sock = dgram.createSocket('udp4')
  // TD-style beacon at 10Hz, timeline running from 100s.
  const beaconStart = Date.now()
  const beacon = setInterval(() => {
    const tl = 100 + (Date.now() - beaconStart) / 1000
    sock.send(oscMessage('/clock', [tl, 1.0]), BEACON_PORT, '127.0.0.1')
  }, 100)
  try {
    await expect(page.locator('.chip', { hasText: 'clock tl=' })).toBeVisible({
      timeout: 5000
    })
    await page.getByRole('button', { name: 'Rec' }).click()
    for (let i = 0; i < 5; i++) {
      sock.send(oscMessage('/x', [i]), LISTEN_PORT, '127.0.0.1')
      await sleep(100)
    }
    await page.getByRole('button', { name: 'Stop' }).click()

    const clip = page.locator('.clip:not(.recording)')
    await expect(clip).toHaveCount(1)
    // offset = median(tl - t) ≈ 100s → placed at ~100s * 20px/s ≈ 2000px.
    const left = await clip.evaluate((el) => parseFloat((el as HTMLElement).style.left))
    expect(left).toBeGreaterThan(1900)
    expect(left).toBeLessThan(2300)
  } finally {
    clearInterval(beacon)
    sock.close()
    await app.close()
  }
})

test('OSC /rec/start & /rec/stop drive recording without touching the UI', async () => {
  const { app, page } = await launchApp()
  const sock = dgram.createSocket('udp4')
  try {
    // Remote start: the REC indicator flips with no UI interaction.
    sock.send(oscMessage('/rec/start', []), BEACON_PORT, '127.0.0.1')
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 5000 })

    for (let i = 0; i < 5; i++) {
      sock.send(oscMessage('/x', [i]), LISTEN_PORT, '127.0.0.1')
      await sleep(100)
    }

    // Remote stop: the finished clip imports as a track.
    sock.send(oscMessage('/rec/stop', []), BEACON_PORT, '127.0.0.1')
    await expect(page.getByRole('button', { name: 'Rec' })).toBeVisible({ timeout: 5000 })
    const clip = page.locator('.clip:not(.recording)')
    await expect(clip).toHaveCount(1)
    await expect(page.locator('.clip-meta')).toContainText('5 ev')
  } finally {
    sock.close()
    await app.close()
  }
})

test('boot: no CLI arg → empty project; broken arg → error + empty project', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  // A project.json in the cwd is NOT auto-loaded anymore.
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      tracks: [{ clips: [] }]
    })
  )
  const env = {
    ...process.env,
    OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
    OSC_EDITOR_HIDDEN: '1',
    OSC_EDITOR_DATA_DIR: workdir
  }
  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js')],
    cwd: workdir,
    env
  })
  const page = await app.firstWindow()
  await expect(page.locator('.timeline-panel')).toBeVisible()
  await expect(page.locator('.track')).toHaveCount(0)
  await expect.poll(() => page.title()).toBe('VTR')
  await app.close()

  // Unparsable project file: error banner, still an empty usable project.
  writeFileSync(join(workdir, 'bad.json'), '{not json')
  const app2 = await electron.launch({
    args: [join(__dirname, '../out/main/index.js'), join(workdir, 'bad.json')],
    cwd: workdir,
    env
  })
  const page2 = await app2.firstWindow()
  await expect(page2.locator('.error-banner')).toContainText('failed to open project')
  await expect(page2.locator('.track')).toHaveCount(0)
  await page2.getByRole('button', { name: '+ Track' }).click()
  await expect(page2.locator('.track')).toHaveCount(1)
  await expect.poll(() => page2.title()).toBe('VTR (edited)')
  await app2.close()
})

test('tracks can be added and deleted without clips', async () => {
  const { app, page, workdir } = await launchApp()
  try {
    await page.getByRole('button', { name: '+ Track' }).click()
    await page.getByRole('button', { name: '+ Track' }).click()
    await expect(page.locator('.track')).toHaveCount(2)
    await save(page)
    await expect.poll(() => readProject(workdir).tracks.length).toBe(2)

    await page.locator('.track-label').first().hover()
    await page.getByLabel('delete track 1').click()
    await expect(page.locator('.track')).toHaveCount(1)
    await save(page)
    await expect.poll(() => readProject(workdir).tracks.length).toBe(1)

    // Empty tracks survive a relaunch.
    await app.close()
    const relaunch = await electron.launch({
      args: [join(__dirname, '../out/main/index.js'), join(workdir, 'project.json')],
      cwd: workdir,
      env: {
        ...process.env,
        OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
        OSC_EDITOR_HIDDEN: '1',
        OSC_EDITOR_DATA_DIR: workdir
      }
    })
    const page2 = await relaunch.firstWindow()
    await expect(page2.locator('.track')).toHaveCount(1)
    await relaunch.close()
  } finally {
    await app.close().catch(() => {})
  }
})
