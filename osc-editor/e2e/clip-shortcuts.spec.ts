import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14910
const FORWARD_PORT = 14911
const BEACON_PORT = 14912

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('clip keyboard shortcuts: Cmd+C / Cmd+V copy-paste at playhead', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
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
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      duration: 10,
      tracks: [{ clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 2 }] }]
    })
  )

  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js')],
    cwd: workdir,
    env: {
      ...process.env,
      OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
      OSC_EDITOR_HIDDEN: '1'
    }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })

    // Copy the clip, seek to ~8s (160px at 20 px/s), paste.
    await page.locator('.clip').click()
    await page.keyboard.press('ControlOrMeta+c')
    await page.locator('.ruler').click({ position: { x: 160, y: 10 } })
    await page.keyboard.press('ControlOrMeta+v')
    await expect(page.locator('.clip')).toHaveCount(2)
    const pastedLeft = parseFloat(
      await page.locator('.clip.selected').evaluate((el) => (el as HTMLElement).style.left)
    )
    expect(Math.abs(pastedLeft - 160)).toBeLessThan(2)

    // Paste again: same clipboard still works.
    await page.locator('.ruler').click({ position: { x: 80, y: 10 } })
    await page.keyboard.press('ControlOrMeta+v')
    await expect(page.locator('.clip')).toHaveCount(3)
  } finally {
    await app.close()
  }
})
