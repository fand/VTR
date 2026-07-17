import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14510
const FORWARD_PORT = 14511
const BEACON_PORT = 14512

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('clip context menu: mute, copy, paste, duplicate, split at playhead', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.1] },
      { t: 0.8, port: LISTEN_PORT, a: '/fader', args: [0.5] },
      { t: 1.4, port: LISTEN_PORT, a: '/fader', args: [0.9] },
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
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })

    const readSession = (): { t?: number; type?: string }[] | null => {
      try {
        return readFileSync(join(workdir, 'session.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      } catch {
        return null
      }
    }

    // Open and close with Escape.
    await page.locator('.clip').click({ button: 'right' })
    await expect(page.getByRole('menuitem')).toHaveCount(6)
    await expect(page.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeEnabled()
    // Playhead at 0 → split disabled; nothing copied yet → paste disabled.
    await expect(page.getByRole('menuitem', { name: 'Split at playhead' })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: 'Paste' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem')).toHaveCount(0)

    // Reveal in Finder: the stubbed showItemInFolder gets the resolved path.
    await app.evaluate(({ shell }) => {
      shell.showItemInFolder = (p: string): void => {
        ;(globalThis as Record<string, unknown>).__revealed = p
      }
    })
    await page.locator('.clip').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Reveal in Finder' }).click()
    await expect
      .poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__revealed))
      .toBe(join(workdir, CLIP))

    // Mute: clip dims, export carries no events.
    await page.locator('.clip').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mute' }).click()
    await expect(page.locator('.clip.muted')).toHaveCount(1)
    await page.getByRole('button', { name: 'Export' }).click()
    await expect.poll(() => readSession()?.length ?? 0).toBe(2) // start + end only

    // Unmute: export carries the 3 events again.
    await page.locator('.clip').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Unmute' }).click()
    await expect(page.locator('.clip.muted')).toHaveCount(0)
    await page.getByRole('button', { name: 'Export' }).click()
    await expect.poll(() => readSession()?.length ?? 0).toBe(5)

    // Duplicate: lands right after the original (2s → left 40px at 20 px/s).
    await page.locator('.clip').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Duplicate' }).click()
    await expect(page.locator('.clip')).toHaveCount(2)
    await expect(page.locator('.clip').nth(1)).toHaveCSS('left', '40px')

    // Copy, seek to ~8s on the ruler, paste: new clip at the playhead.
    await page.locator('.clip').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy' }).click()
    await page.locator('.ruler').click({ position: { x: 160, y: 10 } })
    await page.locator('.clip').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Paste' }).click()
    await expect(page.locator('.clip')).toHaveCount(3)
    const pastedLeft = parseFloat(
      await page.locator('.clip.selected').evaluate((el) => (el as HTMLElement).style.left)
    )
    expect(Math.abs(pastedLeft - 160)).toBeLessThan(2)

    // Split the pasted clip (~8..10s) at ~9s: two ~1s halves.
    await page.locator('.ruler').click({ position: { x: 180, y: 10 } })
    await page.locator('.clip.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Split at playhead' }).click()
    await expect(page.locator('.clip')).toHaveCount(4)
    const lefts = (
      await page
        .locator('.clip')
        .evaluateAll((els) => els.map((el) => parseFloat((el as HTMLElement).style.left)))
    ).sort((a, b) => a - b)
    expect(lefts.length).toBe(4)
    ;[0, 40, 160, 180].forEach((want, i) => expect(Math.abs(lefts[i] - want)).toBeLessThan(2))

    // Muted flag survives in project.json (explicit save), none muted now.
    await page.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => {
        try {
          const p = JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8'))
          return p.tracks[0].clips.length
        } catch {
          return 0
        }
      })
      .toBe(4)
  } finally {
    await app.close()
  }
})
