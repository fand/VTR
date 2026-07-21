import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  curvePoints,
  expectCurveCount,
  expectPointCount,
  expectPropDimmed,
  expectPropDrawn,
  expectPropSelected
} from './curveHooks'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14410
const FORWARD_PORT = 14411

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('curve panel: properties per address/arg, visibility toggle', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
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
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })

    // Nothing selected yet.
    await expect(page.locator('.curve-empty')).toBeVisible()
    await expect(page.locator('.curve-prop')).toHaveCount(0)

    await page.locator('.clip').click()
    // One property per (address, numeric arg): /fader, /xy[0], /xy[1]. /name is a string.
    await expect(page.locator('.curve-prop-name')).toHaveText(['/fader', '/xy[0]', '/xy[1]'])
    await expectCurveCount(page, 3)
    await expectPropDrawn(page, '/fader', true)
    // Points: 3 fader + 2×2 xy.
    await expectPointCount(page, 7)

    // The tooltip always shows the point nearest to the cursor, not only on
    // exact point hover.
    const mid = (await curvePoints(page))[1]
    await page.mouse.move(mid.x + 10, mid.y + 5)
    await expect(page.locator('.curve-tooltip')).toHaveText('/fader: 0.5 @ 0.8s')
    // With a property selected, only its points compete.
    await page.locator('.curve-prop-name', { hasText: '/xy[1]' }).click()
    const editorBox = (await page.locator('.curve-editor').boundingBox())!
    await page.mouse.move(editorBox.x + 15, editorBox.y + editorBox.height / 2)
    await expect(page.locator('.curve-tooltip')).toHaveText('/xy[1]: 0.2 @ 0.5s')
    await page.locator('.curve-prop-name', { hasText: '/xy[1]' }).click()
    // Tooltip clears when the cursor leaves the editor.
    await page.mouse.move(1, 1)
    await expect(page.locator('.curve-tooltip')).toHaveCount(0)

    // Grid: time + value lines; the value axis defaults to 0.0–1.0 even
    // though /fader only spans 0.1…0.9.
    expect(await page.locator('.curve-grid-line').count()).toBeGreaterThan(5)
    await expect(
      page.locator('.curve-ylabels .curve-grid-label').filter({ hasText: /^0\.0$/ })
    ).toHaveCount(1)
    await expect(
      page.locator('.curve-ylabels .curve-grid-label').filter({ hasText: /^1\.0$/ })
    ).toHaveCount(1)
    // Time axis labels sit at the top, in the ruler's format ("1s", not "1.0s").
    const oneSec = page.locator('.curve-grid-label').filter({ hasText: /^1s$/ }).first()
    await expect(oneSec).toBeVisible()
    expect((await oneSec.boundingBox())!.y - editorBox.y).toBeLessThan(20)

    // Selecting a property keeps the 0–1 floor (its 0.2…0.4 data fits inside).
    await page.locator('.curve-prop-name', { hasText: '/xy[1]' }).click()
    await expect(
      page.locator('.curve-ylabels .curve-grid-label').filter({ hasText: /^1\.0$/ })
    ).toHaveCount(1)
    await page.locator('.curve-prop-name', { hasText: '/xy[1]' }).click()

    // Toggle /fader off → its curve disappears.
    await page.getByLabel('toggle /fader').uncheck()
    await expectCurveCount(page, 2)
    await expectPropDrawn(page, '/fader', false)
    await page.getByLabel('toggle /fader').check()
    await expectCurveCount(page, 3)

    // Click a property name → selects it (not a visibility toggle); thick curve.
    await page.locator('.curve-prop-name', { hasText: '/fader' }).click()
    await expect(page.locator('.curve-prop.selected')).toHaveCount(1)
    await expect(page.getByLabel('toggle /fader')).toBeChecked()
    await expectPropSelected(page, '/fader', true)
    await expectPropSelected(page, '/xy[0]', false)
    // Shift+click adds to the selection.
    await page.locator('.curve-prop-name', { hasText: '/xy[0]' }).click({ modifiers: ['Shift'] })
    await expect(page.locator('.curve-prop.selected')).toHaveCount(2)
    await expectPropSelected(page, '/xy[0]', true)
    // Checkbox still toggles visibility only; selection is untouched.
    await page.getByLabel('toggle /xy[1]').uncheck()
    await expect(page.locator('.curve-prop.selected')).toHaveCount(2)
    await page.getByLabel('toggle /xy[1]').check()
    // Click on the sole remaining selection deselects.
    await page.locator('.curve-prop-name', { hasText: '/xy[0]' }).click({ modifiers: ['Shift'] })
    await page.locator('.curve-prop-name', { hasText: '/fader' }).click()
    await expect(page.locator('.curve-prop.selected')).toHaveCount(0)
    await expectPropSelected(page, '/fader', false)

    // Deselect (click empty lane area far from the clip; the ruler swallows
    // pointerdown for seeking, lanes bubble up to the deselect handler).
    // The curve panel keeps showing the last selected clip.
    await page.locator('.track-lane').click({ position: { x: 500, y: 55 } })
    await expect(page.locator('.clip.selected')).toHaveCount(0)
    await expect(page.locator('.curve-prop-name')).toHaveText(['/fader', '/xy[0]', '/xy[1]'])
  } finally {
    await app.close()
  }
})

test('curve panel: filter input narrows the property list and drawn curves', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.1] },
      { t: 0.5, port: LISTEN_PORT, a: '/xy', args: [0.1, 0.2] },
      { t: 0.8, port: LISTEN_PORT, a: '/fader', args: [0.5] },
      { type: 'session_end', t: 2 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    await expect(page.locator('.curve-prop-name')).toHaveText(['/fader', '/xy[0]', '/xy[1]'])
    await expectCurveCount(page, 3)

    // "xy" keeps only /xy[0] and /xy[1], in the list and on the canvas.
    await page.getByLabel('filter properties').fill('xy')
    await expect(page.locator('.curve-prop-name')).toHaveText(['/xy[0]', '/xy[1]'])
    await expectCurveCount(page, 2)
    await expectPropDrawn(page, '/fader', false)

    // No match: empty list, no curves.
    await page.getByLabel('filter properties').fill('nope')
    await expect(page.locator('.curve-prop-name')).toHaveCount(0)
    await expectCurveCount(page, 0)

    // Clearing restores everything.
    await page.getByLabel('filter properties').fill('')
    await expect(page.locator('.curve-prop-name')).toHaveCount(3)
    await expectCurveCount(page, 3)
  } finally {
    await app.close()
  }
})

test('curve panel: property list sorted by address', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      // Insertion order (/zoom, /xy, /fader) differs from address order.
      { t: 0.2, port: LISTEN_PORT, a: '/zoom', args: [1] },
      { t: 0.4, port: LISTEN_PORT, a: '/xy', args: [0.1, 0.2] },
      { t: 0.6, port: LISTEN_PORT, a: '/fader', args: [0.5] },
      { type: 'session_end', t: 1 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      tracks: [{ clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 1 }] }]
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    await expect(page.locator('.curve-prop-name')).toHaveText([
      '/fader',
      '/xy[0]',
      '/xy[1]',
      '/zoom'
    ])
  } finally {
    await app.close()
  }
})

test('curve panel: selecting a property dims other curves and hides their points', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.1] },
      { t: 0.5, port: LISTEN_PORT, a: '/xy', args: [0.1, 0.2] },
      { t: 0.8, port: LISTEN_PORT, a: '/fader', args: [0.5] },
      { t: 1.4, port: LISTEN_PORT, a: '/fader', args: [0.9] },
      { type: 'session_end', t: 2 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    // 3 fader + 2 xy points.
    await expectPointCount(page, 5)

    // Select /fader: other curves dim and lose their points.
    await page.locator('.curve-prop-name', { hasText: '/fader' }).click()
    await expectPropDimmed(page, '/fader', false)
    await expectPropDimmed(page, '/xy[0]', true)
    await expectPropDimmed(page, '/xy[1]', true)
    await expectPointCount(page, 3)
    // Dimmed curves are still drawn.
    await expectCurveCount(page, 3)

    // Deselect: everything back.
    await page.locator('.curve-prop-name', { hasText: '/fader' }).click()
    await expectPropDimmed(page, '/xy[0]', false)
    await expectPointCount(page, 5)
  } finally {
    await app.close()
  }
})

test('curve panel: clicking a curve line selects its property', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.1] },
      { t: 0.5, port: LISTEN_PORT, a: '/xy', args: [0.1, 0.2] },
      { t: 0.8, port: LISTEN_PORT, a: '/fader', args: [0.5] },
      { t: 1.4, port: LISTEN_PORT, a: '/fader', args: [0.9] },
      { type: 'session_end', t: 2 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    // 3 fader + 2 xy points.
    await expectPointCount(page, 5)

    // Click the flat /fader segment between its 2nd and 3rd points (step-after:
    // it sits at the 2nd point's value 0.5) — away from any point, and on the
    // shared 0–1 axis no other curve passes near 0.5 there.
    const fader = (await curvePoints(page)).filter((p) => p.label === '/fader')
    const midX = (fader[1].x + fader[2].x) / 2
    const midY = fader[1].y
    await page.mouse.click(midX, midY)

    // /fader is selected: its row highlights, other curves dim and lose points.
    await expect(page.locator('.curve-prop.selected')).toHaveText(/\/fader/)
    await expectPropDimmed(page, '/xy[0]', true)
    await expectPointCount(page, 3)

    // Clicking the selected curve again deselects it.
    await page.mouse.click(midX, midY)
    await expect(page.locator('.curve-prop.selected')).toHaveCount(0)
    await expectPointCount(page, 5)

    // Select again, then click empty space: the property deselects too.
    await page.mouse.click(midX, midY)
    await expect(page.locator('.curve-prop.selected')).toHaveCount(1)
    const editor = (await page.locator('.curve-editor').boundingBox())!
    await page.mouse.click(editor.x + editor.width * 0.15, editor.y + editor.height * 0.3)
    await expect(page.locator('.curve-prop.selected')).toHaveCount(0)
    await expectPointCount(page, 5)
  } finally {
    await app.close()
  }
})

test('curve panel: multi-select shows every selected clip, timeline time axis', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.1] },
      { t: 0.8, port: LISTEN_PORT, a: '/fader', args: [0.5] },
      { type: 'session_end', t: 1 }
    ])
  )
  writeFileSync(
    join(workdir, 'clip-b.jsonl'),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.9] },
      { type: 'session_end', t: 1 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      tracks: [
        { clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 1 }] },
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
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir
    }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })

    // One clip: its 2 points, no clip-range overlay.
    await page.locator('.clip').first().click()
    await expectPointCount(page, 2)
    await expect(page.locator('.curve-clip-range')).toHaveCount(0)

    // Shift-click the second clip: both clips' events merge into /fader.
    await page
      .locator('.clip')
      .nth(1)
      .click({ modifiers: ['Shift'] })
    await expectPointCount(page, 3)
    await expect(page.locator('.curve-prop-name')).toHaveText(['/fader'])

    // Each clip gets a faint bar+fill over its timeline span.
    await expect(page.locator('.curve-clip-range')).toHaveCount(2)
    const fill0 = (await page.locator('.curve-clip-fill').first().boundingBox())!
    const fill1 = (await page.locator('.curve-clip-fill').nth(1).boundingBox())!
    // Clip A spans 0-1s, clip B 2-3s of a 0-3s axis: fills mirror that ratio.
    expect(fill0.width).toBeLessThan(fill1.x - fill0.x)
    expect(fill1.width).toBeCloseTo(fill0.width, 0)

    // The rightmost point is clip-b's; its tooltip shows timeline time (2 + 0.2).
    const pts = await curvePoints(page)
    const last = pts[pts.length - 1]
    await page.mouse.move(last.x + 2, last.y + 2)
    await expect(page.locator('.curve-tooltip')).toHaveText('/fader: 0.9 @ 2.2s')
  } finally {
    await app.close()
  }
})

test('curve panel: drag and delete points, edits persisted to sidecar', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
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
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    await expectPointCount(page, 3)

    // Drag the middle point right and up: t and value both grow.
    const box = (await curvePoints(page))[1]
    await page.mouse.move(box.x, box.y)
    await page.mouse.down()
    await page.mouse.move(box.x + 40, box.y - 30, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.press('ControlOrMeta+s')

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
    const first = (await curvePoints(page))[0]
    await page.mouse.click(first.x, first.y)
    await expect(page.locator('circle.selected')).toHaveCount(1)
    await page.keyboard.press('Delete')
    await expectPointCount(page, 2)
    // The clip itself must survive (the point owned the Delete key).
    await expect(page.locator('.clip')).toHaveCount(1)
    await page.keyboard.press('ControlOrMeta+s')
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

test('curve panel: transform box moves and scales the selected points', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
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
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    await expectPointCount(page, 3)

    // Single selection: no box.
    const first = (await curvePoints(page))[0]
    await page.mouse.click(first.x, first.y)
    await expect(page.locator('circle.selected')).toHaveCount(1)
    await expect(page.locator('.curve-xform-box')).toHaveCount(0)

    // Marquee all 3 points: the box appears around them.
    const editor = (await page.locator('.curve-editor').boundingBox())!
    await page.mouse.move(editor.x + 4, editor.y + 4)
    await page.mouse.down()
    await page.mouse.move(editor.x + editor.width - 4, editor.y + editor.height - 4, { steps: 5 })
    await page.mouse.up()
    await expect(page.locator('circle.selected')).toHaveCount(3)
    await expect(page.locator('.curve-xform-box')).toHaveCount(1)

    // Drag the box body (a spot inside the box away from points/edges):
    // every point shifts by the same Δt.
    const sidecar = join(workdir, `${CLIP}.edits.json`)
    const readSet = (): Record<string, { t: number; args: Record<string, number> }> => {
      try {
        return JSON.parse(readFileSync(sidecar, 'utf8')).set ?? {}
      } catch {
        return {}
      }
    }
    const box1 = (await page.locator('.curve-xform-box').boundingBox())!
    await page.mouse.move(box1.x + box1.width * 0.6, box1.y + box1.height * 0.4)
    await page.mouse.down()
    await page.mouse.move(box1.x + box1.width * 0.6 + 30, box1.y + box1.height * 0.4, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => Object.keys(readSet()).length).toBe(3)
    const afterMove = readSet()
    expect(afterMove['0'].t).toBeGreaterThan(0.2)
    expect(afterMove['2'].t).toBeGreaterThan(1.4)
    // Selection (and the box) survive the drag.
    await expect(page.locator('circle.selected')).toHaveCount(3)
    await expect(page.locator('.curve-xform-box')).toHaveCount(1)

    // Drag the right edge: the left point stays anchored, the right one stretches.
    const right = (await page.locator('.curve-xform-edge.right').boundingBox())!
    await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2)
    await page.mouse.down()
    await page.mouse.move(right.x + right.width / 2 + 40, right.y + right.height / 2, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readSet()['2'].t).toBeGreaterThan(afterMove['2'].t)
    const afterScale = readSet()
    expect(Math.abs(afterScale['0'].t - afterMove['0'].t)).toBeLessThan(0.01)
    // Values untouched by a horizontal scale.
    expect(afterScale['1'].args['0']).toBeCloseTo(afterMove['1'].args['0'], 5)

    // Drag the top edge upward: the max value grows, the min stays.
    const top = (await page.locator('.curve-xform-edge.top').boundingBox())!
    await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2)
    await page.mouse.down()
    await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2 - 30, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readSet()['2'].args['0']).toBeGreaterThan(afterScale['2'].args['0'])
    expect(readSet()['0'].args['0']).toBeCloseTo(afterScale['0'].args['0'], 5)

    // Click outside the box clears the selection and removes the box.
    await page.mouse.click(editor.x + editor.width - 6, editor.y + editor.height - 6)
    await expect(page.locator('circle.selected')).toHaveCount(0)
    await expect(page.locator('.curve-xform-box')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('curve panel: double-click / cmd+click on a curve inserts a point', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
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
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    await expectPointCount(page, 3)

    const center = async (i: number): Promise<{ x: number; y: number }> => {
      const p = (await curvePoints(page))[i]
      return { x: p.x, y: p.y }
    }

    // Double-click the flat segment between the first two points (step-after:
    // it sits at the first point's value). A point appears there, selected.
    const c0 = await center(0)
    const c1 = await center(1)
    await page.mouse.dblclick((c0.x + c1.x) / 2, c0.y)
    await expectPointCount(page, 4)
    await expect(page.locator('circle.selected')).toHaveCount(1)
    await page.keyboard.press('ControlOrMeta+s')

    const sidecar = join(workdir, `${CLIP}.edits.json`)
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(sidecar, 'utf8')).add?.length ?? 0
        } catch {
          return 0
        }
      })
      .toBe(1)
    const added = JSON.parse(readFileSync(sidecar, 'utf8')).add[0]
    expect(added.a).toBe('/fader')
    expect(added.t).toBeGreaterThan(0.35)
    expect(added.t).toBeLessThan(0.65)
    expect(added.args[0]).toBeGreaterThan(0.05)
    expect(added.args[0]).toBeLessThan(0.15)

    // Cmd+click the next segment: one more point, no marquee side effects.
    const c2 = await center(2)
    const c3 = await center(3)
    await page.keyboard.down('ControlOrMeta')
    await page.mouse.click((c2.x + c3.x) / 2, c2.y)
    await page.keyboard.up('ControlOrMeta')
    await expectPointCount(page, 5)

    // Each insert is one undo step.
    await page.keyboard.press('ControlOrMeta+z')
    await expectPointCount(page, 4)

    // The added point reaches the export.
    await page.getByRole('button', { name: 'File' }).click()
    await page.getByRole('button', { name: 'Export' }).click()
    await expect(page.locator('.sb-log')).toContainText('Exported')
    const events = readFileSync(join(workdir, 'session.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => !l.type)
    expect(events).toHaveLength(4)
  } finally {
    await app.close()
  }
})

test('curve header: snap locks drags to the grid, Box toggles the transform box', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.2] },
      { t: 0.8, port: LISTEN_PORT, a: '/fader', args: [0.5] },
      { t: 1.4, port: LISTEN_PORT, a: '/fader', args: [0.8] },
      { type: 'session_end', t: 3 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      tracks: [{ clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 3 }] }]
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    await expectPointCount(page, 3)

    // Snap on: a free drag of the middle point lands on the grid
    // (0.2s time step, 0.2 value step on the 0–1 axis).
    const snapBtn = page.locator('.curve-header').getByRole('button', { name: 'Snap' })
    await snapBtn.click()
    await expect(snapBtn).toHaveAttribute('aria-pressed', 'true')
    const mid = (await curvePoints(page))[1]
    await page.mouse.move(mid.x, mid.y)
    await page.mouse.down()
    await page.mouse.move(mid.x + 50, mid.y - 20, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.press('ControlOrMeta+s')

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
    expect(set1.t).toBeCloseTo(1.0, 5)
    expect(set1.args['0']).toBeCloseTo(0.6, 5)

    // Box off: multi-selecting no longer shows the transform box.
    const editor = (await page.locator('.curve-editor').boundingBox())!
    await page.mouse.move(editor.x + 4, editor.y + 4)
    await page.mouse.down()
    await page.mouse.move(editor.x + editor.width - 4, editor.y + editor.height - 4, { steps: 5 })
    await page.mouse.up()
    await expect(page.locator('circle.selected')).toHaveCount(3)
    await expect(page.locator('.curve-xform-box')).toHaveCount(1)

    const boxBtn = page.locator('.curve-header').getByRole('button', { name: 'Box' })
    await boxBtn.click()
    await expect(boxBtn).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.curve-xform-box')).toHaveCount(0)
    // The selection itself survives the toggle.
    await expect(page.locator('circle.selected')).toHaveCount(3)

    // Back on: the box returns around the still-selected points.
    await boxBtn.click()
    await expect(page.locator('.curve-xform-box')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('curve header: pencil clicks add points to the selected curve', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
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
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    await expectPointCount(page, 3)

    const pencilBtn = page.locator('.curve-header').getByRole('button', { name: 'Pencil' })
    await pencilBtn.click()
    await expect(pencilBtn).toHaveAttribute('aria-pressed', 'true')

    // No curve selected: a click still rubber-bands / clears, adds nothing.
    const editor = (await page.locator('.curve-editor').boundingBox())!
    await page.mouse.click(editor.x + editor.width / 2, editor.y + editor.height * 0.25)
    await expectPointCount(page, 3)

    // Select /fader, then click empty space: a point lands there, selected.
    await page.locator('.curve-prop-name', { hasText: '/fader' }).click()
    await page.mouse.click(editor.x + editor.width / 2, editor.y + editor.height * 0.25)
    await expectPointCount(page, 4)
    await expect(page.locator('circle.selected')).toHaveCount(1)
    await page.keyboard.press('ControlOrMeta+s')

    const sidecar = join(workdir, `${CLIP}.edits.json`)
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(sidecar, 'utf8')).add?.length ?? 0
        } catch {
          return 0
        }
      })
      .toBe(1)
    const added = JSON.parse(readFileSync(sidecar, 'utf8')).add[0]
    expect(added.a).toBe('/fader')
    // Clicked in the upper quarter: the value lands in the top of 0.1..0.9.
    expect(added.args[0]).toBeGreaterThan(0.6)

    // Drag: points stream in along the stroke.
    await page.mouse.move(editor.x + editor.width * 0.2, editor.y + editor.height * 0.6)
    await page.mouse.down()
    await page.mouse.move(editor.x + editor.width * 0.7, editor.y + editor.height * 0.4, {
      steps: 20
    })
    await page.mouse.up()
    await expect.poll(() => curvePoints(page).then((p) => p.length)).toBeGreaterThan(7)
    const drawn = (await curvePoints(page)).length
    // The whole stroke is selected and lands in the sidecar.
    await expect(page.locator('circle.selected')).toHaveCount(drawn - 4)
    await page.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(sidecar, 'utf8')).add?.length ?? 0
        } catch {
          return 0
        }
      })
      .toBe(drawn - 3)

    // One undo removes the whole stroke.
    await page.keyboard.press('ControlOrMeta+z')
    await expectPointCount(page, 4)

    // Pencil off: an empty-space click goes back to clearing the selection
    // (a spot away from every point and segment).
    await pencilBtn.click()
    await page.mouse.click(editor.x + editor.width * 0.3, editor.y + editor.height * 0.1)
    await expectPointCount(page, 4)
    await expect(page.locator('circle.selected')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('curve panel: marquee selects multiple points, group drag and delete', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
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
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
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
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    await expectPointCount(page, 3)

    // Rubber-band across the whole editor: all 3 points selected.
    const box = (await page.locator('.curve-editor').boundingBox())!
    await page.mouse.move(box.x + 4, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 5 })
    await expect(page.locator('.curve-marquee')).toHaveCount(1)
    await page.mouse.up()
    await expect(page.locator('circle.selected')).toHaveCount(3)

    // Dragging one selected point moves the whole group.
    const midBox = (await curvePoints(page))[1]
    await page.mouse.move(midBox.x, midBox.y)
    await page.mouse.down()
    await page.mouse.move(midBox.x + 40, midBox.y, {
      steps: 5
    })
    await page.mouse.up()
    await page.keyboard.press('ControlOrMeta+s')
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
    await expectPointCount(page, 0)
    await expect(page.locator('.clip')).toHaveCount(1)

    // A plain click on empty space clears the marquee selection state (no crash).
    await page.mouse.click(box.x + 10, box.y + 10)
  } finally {
    await app.close()
  }
})
