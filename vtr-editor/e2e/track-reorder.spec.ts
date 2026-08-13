import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 16010
const FORWARD_PORT = 16011

const A = 'clip-a.jsonl'
const B = 'clip-b.jsonl'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
/** TRACK_HEIGHT in Timeline.tsx: one row of vertical drag. */
const ROW = 64

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function savedOrder(workdir: string): string[] {
  const project = JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8'))
  return project.tracks.map((t: { clips: { file: string }[] }) => t.clips[0].file)
}

// Row order is playback priority (the lower track wins), so a reorder commits
// through the normal undo history.
test('track drag-sort: reorder by label drag, undoable; click still selects', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  for (const [file, addr] of [
    [A, '/a'],
    [B, '/b']
  ]) {
    writeFileSync(
      join(workdir, file),
      jsonl([
        { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
        { t: 0.5, port: LISTEN_PORT, a: addr, args: [0.1] },
        { type: 'session_end', t: 1 }
      ])
    )
  }
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      tracks: [
        { clips: [{ file: A, offset: 0, trimIn: 0, trimOut: 1 }] },
        { clips: [{ file: B, offset: 2, trimIn: 0, trimOut: 1 }] }
      ]
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
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })

    const rows = page.locator('.track .clip .editable-label')
    await expect(rows).toHaveText([A, B])

    // A plain click on the label still selects (select moved to pointer-up).
    await page.locator('.track .track-label').nth(0).click()
    await expect(page.locator('.track-label.selected')).toHaveCount(1)

    // Drag track 1's label down one row: the tracks swap.
    const dragLabel = async (idx: number, dy: number): Promise<void> => {
      const box = (await page.locator('.track .track-label').nth(idx).boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 5 })
      await page.mouse.up()
    }
    await dragLabel(0, ROW)
    await expect(rows).toHaveText([B, A])
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => savedOrder(workdir)).toEqual([B, A])

    // One undo entry for the whole drag.
    await page.keyboard.press(`${MOD}+z`)
    await expect(rows).toHaveText([A, B])
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => savedOrder(workdir)).toEqual([A, B])

    // The drag doesn't eat the rename gesture.
    await page.locator('.track-label .editable-label').nth(0).dblclick()
    await expect(page.locator('.rename-input')).toBeVisible()
    await page.keyboard.press('Escape')

    // Nor the delete button (it stops the label's pointerdown).
    await page.locator('.track-del').nth(1).click()
    await expect(page.locator('.track')).toHaveCount(1)
  } finally {
    await app.close()
  }
})
