import { _electron as electron, ElectronApplication, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14510
const FORWARD_PORT = 14511
const BEACON_PORT = 14512

const CLIP = 'clip-a.jsonl'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function launch(workdir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(__dirname, '../out/main/index.js'), join(workdir, 'project.json')],
    cwd: workdir,
    env: {
      ...process.env,
      OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir
    }
  })
}

function savedOffset(workdir: string): number {
  return JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8')).tracks[0].clips[0].offset
}

function savedSeq(workdir: string): number | undefined {
  return JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8')).undoSeq
}

test('undo/redo: one entry per drag, survives restart, linear truncation', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.5, port: LISTEN_PORT, a: '/a', args: [0.1] },
      { t: 1.5, port: LISTEN_PORT, a: '/a', args: [0.9] },
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

  let app = await launch(workdir)
  let page = await app.firstWindow()
  await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })

  // Drag the clip +100px = +5s at 20px/s → one undo entry.
  const dragClip = async (px: number): Promise<void> => {
    const box = (await page.locator('.clip').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + px, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
  }
  await dragClip(100)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(4)
  await expect.poll(() => savedSeq(workdir)).toBe(1)

  // In-session undo and redo via keyboard.
  await page.keyboard.press(`${MOD}+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeLessThan(1)
  await expect.poll(() => savedSeq(workdir)).toBe(0)
  await page.keyboard.press(`${MOD}+Shift+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(4)
  await expect.poll(() => savedSeq(workdir)).toBe(1)

  // Undo survives a restart.
  await app.close()
  app = await launch(workdir)
  page = await app.firstWindow()
  await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
  await expect.poll(async () => (await page.locator('.clip').boundingBox())!.x).toBeGreaterThan(100)
  await page.keyboard.press(`${MOD}+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeLessThan(1)

  // A new edit after undo truncates the redo branch (linear history).
  await dragClip(40)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(1.5)
  const offsetAfter = savedOffset(workdir)
  await page.keyboard.press(`${MOD}+Shift+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(400)
  expect(savedOffset(workdir)).toBe(offsetAfter)
  const seqs = readFileSync(join(workdir, 'undo.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).seq)
  expect(seqs).toEqual([2])

  await app.close()
})
