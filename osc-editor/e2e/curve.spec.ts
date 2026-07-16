import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

    // Hover a point: tooltip with property, value and time; leaves on move-away.
    await page.locator('circle').nth(1).hover()
    await expect(page.locator('.curve-tooltip')).toHaveText('/fader: 0.5 @ 0.8s')
    await page.mouse.move(1, 1)
    await expect(page.locator('.curve-tooltip')).toHaveCount(0)

    // Grid: time + value lines, value labels on /fader's scale (0.1…0.9 → 0.1 step).
    expect(await page.locator('.curve-grid-line').count()).toBeGreaterThan(5)
    await expect(page.locator('.curve-grid-label').filter({ hasText: /^0\.5$/ })).toHaveCount(1)

    // Toggle /fader off → its polyline disappears.
    await page.getByLabel('toggle /fader').uncheck()
    await expect(page.locator('polyline')).toHaveCount(2)
    await expect(page.locator('polyline[data-prop="/fader"]')).toHaveCount(0)
    await page.getByLabel('toggle /fader').check()
    await expect(page.locator('polyline')).toHaveCount(3)

    // Click a property name → selects it (not a visibility toggle); thick curve.
    const strokeW = (prop: string): Promise<string | null> =>
      page.locator(`polyline[data-prop="${prop}"]`).getAttribute('stroke-width')
    await page.locator('.curve-prop-name', { hasText: '/fader' }).click()
    await expect(page.locator('.curve-prop.selected')).toHaveCount(1)
    await expect(page.getByLabel('toggle /fader')).toBeChecked()
    expect(await strokeW('/fader')).toBe('3')
    expect(await strokeW('/xy[0]')).toBe('1.5')
    // Shift+click adds to the selection.
    await page.locator('.curve-prop-name', { hasText: '/xy[0]' }).click({ modifiers: ['Shift'] })
    await expect(page.locator('.curve-prop.selected')).toHaveCount(2)
    expect(await strokeW('/xy[0]')).toBe('3')
    // Checkbox still toggles visibility only; selection is untouched.
    await page.getByLabel('toggle /xy[1]').uncheck()
    await expect(page.locator('.curve-prop.selected')).toHaveCount(2)
    await page.getByLabel('toggle /xy[1]').check()
    // Click on the sole remaining selection deselects.
    await page.locator('.curve-prop-name', { hasText: '/xy[0]' }).click({ modifiers: ['Shift'] })
    await page.locator('.curve-prop-name', { hasText: '/fader' }).click()
    await expect(page.locator('.curve-prop.selected')).toHaveCount(0)
    expect(await strokeW('/fader')).toBe('1.5')

    // Deselect (click empty lane area far from the clip; the ruler swallows
    // pointerdown for seeking, lanes bubble up to the deselect handler).
    await page.locator('.track-lane').click({ position: { x: 500, y: 55 } })
    await expect(page.locator('.curve-prop')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('curve panel: drag and delete points, edits persisted to sidecar', async () => {
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
    await page.locator('.clip').click()
    await expect(page.locator('circle')).toHaveCount(3)

    // Drag the middle point right and up: t and value both grow.
    const mid = page.locator('circle').nth(1)
    const box = (await mid.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 - 30, { steps: 5 })
    await page.mouse.up()

    const sidecar = join(workdir, `${CLIP}.edits.json`)
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(sidecar, 'utf8')).set?.['1'] ?? null
        } catch {
          return null
        }
      })
      .not.toBeNull()
    const set1 = JSON.parse(readFileSync(sidecar, 'utf8')).set['1']
    expect(set1.t).toBeGreaterThan(0.8)
    expect(set1.args['0']).toBeGreaterThan(0.5)
    // Edits stay out of project.json.
    expect(JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8')).edits).toBeUndefined()

    // Select the first point (plain click) and delete it.
    await page.locator('circle').first().click()
    await expect(page.locator('circle.selected')).toHaveCount(1)
    await page.keyboard.press('Delete')
    await expect(page.locator('circle')).toHaveCount(2)
    // The clip itself must survive (the point owned the Delete key).
    await expect(page.locator('.clip')).toHaveCount(1)
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(sidecar, 'utf8')).del?.['0'] ?? null
        } catch {
          return null
        }
      })
      .toBe(true)
  } finally {
    await app.close()
  }
})

test('curve panel: marquee selects multiple points, group drag and delete', async () => {
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
    await page.locator('.clip').click()
    await expect(page.locator('circle')).toHaveCount(3)

    // Rubber-band across the whole editor: all 3 points selected.
    const box = (await page.locator('.curve-editor').boundingBox())!
    await page.mouse.move(box.x + 4, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 5 })
    await expect(page.locator('.curve-marquee')).toHaveCount(1)
    await page.mouse.up()
    await expect(page.locator('circle.selected')).toHaveCount(3)

    // Dragging one selected point moves the whole group.
    const mid = page.locator('circle').nth(1)
    const midBox = (await mid.boundingBox())!
    await page.mouse.move(midBox.x + midBox.width / 2, midBox.y + midBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(midBox.x + midBox.width / 2 + 40, midBox.y + midBox.height / 2, {
      steps: 5
    })
    await page.mouse.up()
    const sidecar = join(workdir, `${CLIP}.edits.json`)
    await expect
      .poll(() => {
        try {
          return Object.keys(JSON.parse(readFileSync(sidecar, 'utf8')).set ?? {}).length
        } catch {
          return 0
        }
      })
      .toBe(3)
    const set = JSON.parse(readFileSync(sidecar, 'utf8')).set
    expect(set['0'].t).toBeGreaterThan(0.2)
    expect(set['2'].t).toBeGreaterThan(1.4)

    // Group stays selected; Delete removes all of them.
    await expect(page.locator('circle.selected')).toHaveCount(3)
    await page.keyboard.press('Delete')
    await expect(page.locator('circle')).toHaveCount(0)
    await expect(page.locator('.clip')).toHaveCount(1)

    // A plain click on empty space clears the marquee selection state (no crash).
    await page.mouse.click(box.x + 10, box.y + 10)
  } finally {
    await app.close()
  }
})
