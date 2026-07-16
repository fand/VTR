import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14410
const FORWARD_PORT = 14411
const BEACON_PORT = 14412

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('curve panel: properties per address/arg, visibility toggle', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.1] },
      { t: 0.5, port: LISTEN_PORT, a: '/xy', args: [0.1, 0.2] },
      { t: 0.6, port: LISTEN_PORT, a: '/name', args: ['hello'] },
      { t: 0.8, port: LISTEN_PORT, a: '/fader', args: [0.5] },
      { t: 1.0, port: LISTEN_PORT, a: '/xy', args: [0.3, 0.4] },
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

    // Nothing selected yet.
    await expect(page.locator('.curve-empty')).toBeVisible()
    await expect(page.locator('.curve-prop')).toHaveCount(0)

    await page.locator('.clip').click()
    // One property per (address, numeric arg): /fader, /xy[0], /xy[1]. /name is a string.
    await expect(page.locator('.curve-prop-name')).toHaveText(['/fader', '/xy[0]', '/xy[1]'])
    await expect(page.locator('polyline')).toHaveCount(3)
    await expect(page.locator('polyline[data-prop="/fader"]')).toHaveCount(1)
    // Circles: 3 fader points + 2×2 xy points.
    await expect(page.locator('circle')).toHaveCount(7)

    // Toggle /fader off → its polyline disappears.
    await page.getByLabel('toggle /fader').uncheck()
    await expect(page.locator('polyline')).toHaveCount(2)
    await expect(page.locator('polyline[data-prop="/fader"]')).toHaveCount(0)
    await page.getByLabel('toggle /fader').check()
    await expect(page.locator('polyline')).toHaveCount(3)

    // Deselect (click empty lane area far from the clip; the ruler swallows
    // pointerdown for seeking, lanes bubble up to the deselect handler).
    await page.locator('.track-lane').click({ position: { x: 500, y: 55 } })
    await expect(page.locator('.curve-prop')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
