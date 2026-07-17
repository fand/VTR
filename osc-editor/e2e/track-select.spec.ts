import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 15210
const FORWARD_PORT = 15211
const BEACON_PORT = 15212

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('track select: cmd/shift multi-select, curve shows track clips', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  writeFileSync(
    join(workdir, 'clip-a.jsonl'),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/a', args: [0.1] },
      { t: 0.8, port: LISTEN_PORT, a: '/a', args: [0.5] },
      { type: 'session_end', t: 1 }
    ])
  )
  writeFileSync(
    join(workdir, 'clip-b.jsonl'),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.5, port: LISTEN_PORT, a: '/b', args: [0.9] },
      { type: 'session_end', t: 1 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      duration: 10,
      tracks: [
        { clips: [{ file: 'clip-a.jsonl', offset: 0, trimIn: 0, trimOut: 1 }] },
        { clips: [{ file: 'clip-b.jsonl', offset: 2, trimIn: 0, trimOut: 1 }] }
      ]
    })
  )

  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js'), join(workdir, 'project.json')],
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

    // Click track 1's label: selected, its clip's events fill the curve panel
    // with no clip selected.
    await page.locator('.track .track-label').nth(0).click()
    await expect(page.locator('.track-label.selected')).toHaveCount(1)
    await expect(page.locator('.clip.selected')).toHaveCount(0)
    await expect(page.locator('.curve-prop-name')).toHaveText(['/a'])
    await expect(page.locator('circle')).toHaveCount(2)

    // Cmd-click track 2: both tracks selected, curves merge.
    await page
      .locator('.track .track-label')
      .nth(1)
      .click({ modifiers: ['ControlOrMeta'] })
    await expect(page.locator('.track-label.selected')).toHaveCount(2)
    await expect(page.locator('.curve-prop-name')).toHaveText(['/a', '/b'])
    await expect(page.locator('circle')).toHaveCount(3)

    // Shift-click track 2 again: toggled off.
    await page
      .locator('.track .track-label')
      .nth(1)
      .click({ modifiers: ['Shift'] })
    await expect(page.locator('.track-label.selected')).toHaveCount(1)
    await expect(page.locator('circle')).toHaveCount(2)

    // Selecting a clip clears the track selection; the clip wins the curve panel.
    await page.locator('.clip').nth(1).click()
    await expect(page.locator('.track-label.selected')).toHaveCount(0)
    await expect(page.locator('.curve-prop-name')).toHaveText(['/b'])

    // Back to a track; an empty-lane click clears the selection but the
    // curve panel keeps showing the last selection's clips.
    await page.locator('.track .track-label').nth(0).click()
    await expect(page.locator('.track-label.selected')).toHaveCount(1)
    await page
      .locator('.track-lane')
      .nth(0)
      .click({ position: { x: 500, y: 40 } })
    await expect(page.locator('.track-label.selected')).toHaveCount(0)
    await expect(page.locator('.curve-prop-name')).toHaveText(['/a'])

    // A new selection replaces it.
    await page.locator('.clip').nth(1).click()
    await expect(page.locator('.curve-prop-name')).toHaveText(['/b'])
  } finally {
    await app.close()
  }
})
