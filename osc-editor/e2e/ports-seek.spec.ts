import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'
import dgram from 'node:dgram'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      sock.send(oscMessage('/x', [i]), 10010, '127.0.0.1')
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
    expect(project.ports).toEqual({ listen: 11010, forward: 11011 })
  } finally {
    td.close()
    sock.close()
    await app.close()
  }
})
