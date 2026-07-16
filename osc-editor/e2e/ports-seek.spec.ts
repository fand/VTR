import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'
import dgram from 'node:dgram'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance never collides.
const LISTEN_PORT = 14210
const FORWARD_PORT = 14211
const BEACON_PORT = 14212

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
  const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      tracks: []
    })
  )
  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js')],
    cwd: workdir,
    env: {
      ...process.env,
      OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap')
    }
  })
  const page = await app.firstWindow()
  await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
  return { app, page, workdir }
}

async function playheadLeft(page: Page): Promise<number> {
  return page.locator('.playhead').evaluate((el) => parseFloat((el as HTMLElement).style.left))
}

test('seek: ruler click, lane click, scrub', async () => {
  const { app, page } = await launchApp()
  const sock = dgram.createSocket('udp4')
  try {
    // Need one clip so there is a track lane to click.
    await page.getByRole('button', { name: '● Rec' }).click()
    for (let i = 0; i < 5; i++) {
      sock.send(oscMessage('/x', [i]), LISTEN_PORT, '127.0.0.1')
      await sleep(100)
    }
    await page.getByRole('button', { name: '■ Stop' }).click()
    await expect(page.locator('.clip:not(.recording)')).toHaveCount(1)

    // Ruler click at x=200 → playhead at 96 + 200.
    await page.locator('.ruler').click({ position: { x: 200, y: 10 } })
    expect(await playheadLeft(page)).toBeCloseTo(296, 0)
    await expect(page.locator('.timecode')).toHaveText('00:00:10.000')

    // Empty lane click at x=300.
    await page.locator('.track-lane').first().click({ position: { x: 300, y: 55 } })
    expect(await playheadLeft(page)).toBeCloseTo(396, 0)

    // Scrub: drag along the ruler.
    const ruler = page.locator('.ruler')
    const box = (await ruler.boundingBox())!
    await page.mouse.move(box.x + 100, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + 150, box.y + 10, { steps: 5 })
    await page.mouse.up()
    expect(await playheadLeft(page)).toBeCloseTo(246, 0)
  } finally {
    sock.close()
    await app.close()
  }
})

test('clock port editable; beacon received on new port', async () => {
  const { app, page } = await launchApp()
  const sock = dgram.createSocket('udp4')
  try {
    await page.getByLabel('clock port').fill('12012')
    await page.getByLabel('clock port').press('Enter')
    await sleep(2500) // tap restart
    const beacon = setInterval(() => {
      sock.send(oscMessage('/clock', [50, 1.0]), 12012, '127.0.0.1')
    }, 100)
    try {
      await expect(page.locator('.chip', { hasText: 'clock tl=' })).toBeVisible({
        timeout: 15_000
      })
    } finally {
      clearInterval(beacon)
    }
  } finally {
    sock.close()
    await app.close()
  }
})

test('timeline duration and zoom slider', async () => {
  const { app, page, workdir } = await launchApp()
  try {
    // Longer timeline persists and widens the ruler.
    await page.getByLabel('timeline duration').fill('120')
    await page.getByLabel('timeline duration').press('Enter')
    // Autosave is debounced; poll instead of a fixed sleep.
    await expect
      .poll(() => JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8')).duration)
      .toBe(120)
    // 120s at default 20px/s → ruler is 2400px wide.
    const rulerW = await page
      .locator('.ruler')
      .evaluate((el) => parseFloat((el as HTMLElement).style.width))
    expect(rulerW).toBeCloseTo(2400, 0)

    // Zoom slider changes px/s: max slider → 400px/s.
    await page.getByLabel('zoom').fill('100')
    const rulerW2 = await page
      .locator('.ruler')
      .evaluate((el) => parseFloat((el as HTMLElement).style.width))
    expect(rulerW2).toBeCloseTo(120 * 400, -1)
  } finally {
    await app.close()
  }
})

test('timeline duration: arithmetic input and label drag', async () => {
  const { app, page, workdir } = await launchApp()
  try {
    // Arithmetic: 60*2 → 120.
    const field = page.getByLabel('timeline duration')
    await field.fill('60*2')
    await field.press('Enter')
    await expect(field).toHaveValue('120')

    // Bad expression reverts.
    await field.fill('60*')
    await field.press('Enter')
    await expect(field).toHaveValue('120')

    // Dragging the unfocused input right by 40px adds 40s (and doesn't focus it).
    const box = (await field.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 40, cy, { steps: 5 })
    await page.mouse.up()
    await expect(field).toHaveValue('160')
    await expect(field).not.toBeFocused()

    await expect
      .poll(() => JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8')).duration)
      .toBe(160)

    // A plain click focuses it and it edits like a normal input.
    await page.mouse.click(cx, cy)
    await expect(field).toBeFocused()
    await page.keyboard.type('99')
    await page.keyboard.press('Enter')
    await expect(field).toHaveValue('99')
  } finally {
    await app.close()
  }
})

test('ports editable in header; tap restarts on new ports', async () => {
  const { app, page, workdir } = await launchApp()
  const sock = dgram.createSocket('udp4')
  const td = dgram.createSocket('udp4')
  const forwarded: Buffer[] = []
  td.on('message', (m) => forwarded.push(m))
  await new Promise<void>((r) => td.bind(11011, '127.0.0.1', r))
  try {
    await page.getByLabel('in port').fill('11010')
    await page.getByLabel('in port').press('Enter')
    await page.getByLabel('out port').fill('11011')
    await page.getByLabel('out port').press('Enter')

    // tap restarts (child respawn ~1s); wait until it records on the new port.
    await sleep(2500)
    await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })

    await page.getByRole('button', { name: '● Rec' }).click()
    for (let i = 0; i < 5; i++) {
      sock.send(oscMessage('/y', [i]), 11010, '127.0.0.1')
      await sleep(100)
    }
    await page.getByRole('button', { name: '■ Stop' }).click()
    await expect(page.locator('.clip:not(.recording)')).toHaveCount(1)
    await expect(page.locator('.clip-meta').first()).toContainText('5 ev')
    expect(forwarded.length).toBe(5)

    // Persisted to project.json.
    await sleep(600)
    const project = JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8'))
    expect(project.ports).toEqual({ listen: 11010, forward: 11011, beacon: BEACON_PORT })
  } finally {
    td.close()
    sock.close()
    await app.close()
  }
})
