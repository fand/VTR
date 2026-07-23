import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 15010
const FORWARD_PORT = 15011

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('clip multi-select: shift-click, group duplicate/delete/drag', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.1] },
      { type: 'session_end', t: 2 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      tracks: [
        {
          clips: [
            { file: CLIP, offset: 0, trimIn: 0, trimOut: 2 },
            { file: CLIP, offset: 4, trimIn: 0, trimOut: 2 }
          ]
        }
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

    const lefts = async (sel: string): Promise<number[]> =>
      (
        await page
          .locator(sel)
          .evaluateAll((els) => els.map((el) => parseFloat((el as HTMLElement).style.left)))
      ).sort((a, b) => a - b)

    // Shift-click selects both; shift-click again deselects.
    await page.locator('.clip').nth(0).click()
    await page
      .locator('.clip')
      .nth(1)
      .click({ modifiers: ['Shift'] })
    await expect(page.locator('.clip.selected')).toHaveCount(2)
    await page
      .locator('.clip')
      .nth(1)
      .click({ modifiers: ['Shift'] })
    await expect(page.locator('.clip.selected')).toHaveCount(1)
    await page
      .locator('.clip')
      .nth(1)
      .click({ modifiers: ['Shift'] })
    await expect(page.locator('.clip.selected')).toHaveCount(2)

    // Cmd+D duplicates both (0s→2s, 4s→6s at 20 px/s).
    await page.keyboard.press('ControlOrMeta+d')
    await expect(page.locator('.clip')).toHaveCount(4)
    await expect(page.locator('.clip.selected')).toHaveCount(2)
    expect(await lefts('.clip')).toEqual([0, 40, 80, 120])
    expect(await lefts('.clip.selected')).toEqual([40, 120])

    // Delete removes the selected duplicates.
    await page.keyboard.press('Backspace')
    await expect(page.locator('.clip')).toHaveCount(2)
    expect(await lefts('.clip')).toEqual([0, 80])

    // Dragging one selected clip moves the whole selection (+40px = +2s).
    await page.locator('.clip').nth(0).click()
    await page
      .locator('.clip')
      .nth(1)
      .click({ modifiers: ['Shift'] })
    const box = (await page.locator('.clip').nth(0).boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 40, cy, { steps: 4 })
    await page.mouse.up()
    expect(await lefts('.clip')).toEqual([40, 120])
    await expect(page.locator('.clip.selected')).toHaveCount(2)
  } finally {
    await app.close()
  }
})
