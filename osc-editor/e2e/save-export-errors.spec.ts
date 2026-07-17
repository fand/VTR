import { _electron as electron, ElectronApplication, expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance never collides.
const LISTEN_PORT = 15810
const FORWARD_PORT = 15811
const BEACON_PORT = 15812

const CLIP = 'clip-a.jsonl'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function setup(workdir: string): void {
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.5, port: LISTEN_PORT, a: '/a', args: [0.1] },
      { type: 'session_end', t: 2 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      duration: 10,
      tracks: [{ clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 2 }] }]
    })
  )
}

function launch(workdir: string, env: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(__dirname, '../out/main/index.js'), join(workdir, 'project.json')],
    cwd: workdir,
    env: {
      ...process.env,
      OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir,
      ...env
    }
  })
}

function savedOffset(workdir: string): number {
  return JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8')).tracks[0].clips[0].offset
}

test('cancelled Save As dialog saves nothing and shows no error', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  setup(workdir)
  // Empty OSC_EDITOR_DIALOG_PATH = the user cancels every save dialog.
  const app = await launch(workdir, { OSC_EDITOR_DIALOG_PATH: '' })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })

    // Dirty the doc, then Save As → cancel.
    const box = (await page.locator('.clip').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.press(`${MOD}+Shift+s`)
    await page.waitForTimeout(400)
    expect(savedOffset(workdir)).toBe(0)
    await expect(page.locator('.error-banner')).toHaveCount(0)
    expect(existsSync(join(workdir, 'Untitled.oscproj'))).toBe(false)

    // Plain save (existing path, no dialog) still works after the cancel.
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(4)
  } finally {
    await app.close()
  }
})

test('export write failure lands in the error banner', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  setup(workdir)
  // A directory squatting on the output path makes the write fail.
  mkdirSync(join(workdir, 'session.jsonl'))
  const app = await launch(workdir)
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
    await page.getByRole('button', { name: 'Export' }).click()
    await expect(page.locator('.error-banner')).toBeVisible()
    await expect(page.locator('.info-banner')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
