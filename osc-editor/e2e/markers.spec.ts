import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14810
const FORWARD_PORT = 14811
const BEACON_PORT = 14812

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('timeline markers: add at playhead, persist in project.json', async () => {
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

    const readMarkers = (): { time: number; label?: string }[] => {
      try {
        const p = JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8'))
        return p.markers ?? []
      } catch {
        return []
      }
    }

    // Seek to ~8s (160px at 20 px/s), add a marker at the playhead.
    await page.locator('.ruler').click({ position: { x: 160, y: 10 } })
    await page.getByRole('button', { name: '+ Marker' }).click()
    await expect(page.locator('.marker-flag')).toHaveCount(1)
    await expect(page.locator('.marker-flag')).toHaveText('M1')
    await expect(page.locator('.marker-line')).toHaveCount(1)
    const left = parseFloat(
      await page.locator('.marker-flag').evaluate((el) => (el as HTMLElement).style.left)
    )
    expect(Math.abs(left - 160)).toBeLessThan(2)

    // A second one at 0s, via the M key.
    await page.locator('.ruler').click({ position: { x: 0, y: 10 } })
    await page.keyboard.press('m')
    await expect(page.locator('.marker-flag')).toHaveCount(2)

    // Autosave persists both.
    await expect.poll(() => readMarkers().length).toBe(2)
    expect(Math.abs(readMarkers()[0].time - 8)).toBeLessThan(0.1)

    // Double-click renames; the label persists.
    await page.locator('.marker-flag').first().dblclick()
    await page.getByLabel('rename marker 1').fill('drop')
    await page.getByLabel('rename marker 1').press('Enter')
    await expect(page.locator('.marker-flag').first()).toHaveText('drop')
    await expect.poll(() => readMarkers()[0]?.label).toBe('drop')
  } finally {
    await app.close()
  }
})
