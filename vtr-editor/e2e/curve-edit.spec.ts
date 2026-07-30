import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { curveKnots, expectPropCounts } from './curveHooks'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14440
const FORWARD_PORT = 14441

const CLIP = 'clip-a.jsonl'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

interface SidecarKnot {
  t: number
  v: number
  i?: [number, number]
  o?: [number, number]
}

test('bezier knots: drag, handles, transform box, delete', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  // A V-shaped /fader ramp: the corner forces the fit to split, so the
  // curve keeps an interior knot to grab.
  const fader = Array.from({ length: 25 }, (_, i) => {
    const t = 0.1 + i * 0.1
    return { t, port: LISTEN_PORT, a: '/fader', args: [Number(Math.abs(t - 1.3).toFixed(4))] }
  })
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      ...fader,
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
      VTR_TAP_BIN: join(__dirname, '../../target/debug/vtr-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir
    }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })

    await page.locator('.clip').click()
    await expectPropCounts(page, '/fader', 25, 0)
    await page.locator('.curve-prop-name', { hasText: '/fader' }).click()
    await page.locator('button[aria-label="replace with curve"]').click()
    await expectPropCounts(page, '/fader', 0, 1)

    const sidecar = join(workdir, `${CLIP}.edits.json`)
    const readKnots = (): SidecarKnot[] => {
      try {
        return JSON.parse(readFileSync(sidecar, 'utf8')).curves?.[0]?.knots ?? []
      } catch {
        return []
      }
    }

    const knots0 = await curveKnots(page)
    expect(knots0.length).toBeGreaterThanOrEqual(3)
    // The knot nearest the V corner is interior: it has both handles.
    const corner = knots0.reduce((a, b) => (Math.abs(b.t - 1.3) < Math.abs(a.t - 1.3) ? b : a))
    const cornerIdx = knots0.indexOf(corner)

    // Drag the corner knot right and up: t and v both grow, neighbors stay.
    await page.mouse.move(corner.x, corner.y)
    await page.mouse.down()
    await page.mouse.move(corner.x + 30, corner.y - 30, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => curveKnots(page).then((ks) => ks[cornerIdx].selected)).toBe(true)
    const dragged = (await curveKnots(page))[cornerIdx]
    expect(dragged.t).toBeGreaterThan(corner.t + 0.05)
    expect(dragged.v).toBeGreaterThan(corner.v + 0.05)
    expect((await curveKnots(page))[0].t).toBeCloseTo(knots0[0].t, 5)

    // One undo entry per drag.
    await page.keyboard.press(`${MOD}+z`)
    await expect.poll(() => curveKnots(page).then((ks) => ks[cornerIdx].t)).toBeCloseTo(corner.t, 5)
    await page.keyboard.press(`${MOD}+Shift+z`)
    await expect
      .poll(() => curveKnots(page).then((ks) => ks[cornerIdx].t))
      .toBeCloseTo(dragged.t, 5)

    // Undo/redo cleared the selection; a click on the interior knot selects
    // it and shows both handles. Dragging one writes the handle offset onto
    // the knot (baseline from the pre-drag save).
    const reKnot = (await curveKnots(page))[cornerIdx]
    await page.mouse.click(reKnot.x, reKnot.y)
    await expect(page.locator('.curve-knot.selected')).toHaveCount(1)
    await expect(page.locator('.curve-handle')).toHaveCount(2)
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readKnots().length).toBe(knots0.length)
    const o0 = readKnots()[cornerIdx].o?.[1] ?? 0
    const out = (await page.locator('.curve-handle.out').boundingBox())!
    await page.mouse.move(out.x + out.width / 2, out.y + out.height / 2)
    await page.mouse.down()
    await page.mouse.move(out.x + out.width / 2 + 10, out.y + out.height / 2 - 25, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readKnots()[cornerIdx]?.o?.[1] ?? -Infinity).toBeGreaterThan(o0 + 0.02)
    const savedKnots = readKnots()
    // Handle dt stays inside the segment (monotone time).
    expect(savedKnots[cornerIdx].o![0]).toBeGreaterThanOrEqual(0)
    expect(savedKnots[cornerIdx].o![0]).toBeLessThanOrEqual(
      savedKnots[cornerIdx + 1].t - savedKnots[cornerIdx].t
    )

    // Marquee all knots: the transform box wraps them; dragging its body
    // moves the whole curve rigidly.
    const editor = (await page.locator('.curve-editor').boundingBox())!
    await page.mouse.move(editor.x + 4, editor.y + 4)
    await page.mouse.down()
    await page.mouse.move(editor.x + editor.width - 4, editor.y + editor.height - 4, { steps: 5 })
    await page.mouse.up()
    await expect(page.locator('.curve-knot.selected')).toHaveCount(knots0.length)
    await expect(page.locator('.curve-xform-box')).toHaveCount(1)
    const before = await curveKnots(page)
    const box = (await page.locator('.curve-xform-box').boundingBox())!
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.15)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.5 + 30, box.y + box.height * 0.15, { steps: 5 })
    await page.mouse.up()
    await expect
      .poll(() => curveKnots(page).then((ks) => ks[0].t))
      .toBeGreaterThan(before[0].t + 0.05)
    const after = await curveKnots(page)
    const dt = after[0].t - before[0].t
    after.forEach((k, i) => expect(k.t - before[i].t).toBeCloseTo(dt, 3))

    // A plain click inside the box clears the selection; then a click on one
    // knot selects just it, and Delete removes only that knot.
    const box2 = (await page.locator('.curve-xform-box').boundingBox())!
    await page.mouse.click(box2.x + box2.width * 0.5, box2.y + box2.height * 0.15)
    await expect(page.locator('.curve-xform-box')).toHaveCount(0)
    const target = (await curveKnots(page))[cornerIdx]
    await page.mouse.click(target.x, target.y)
    await expect(page.locator('.curve-knot.selected')).toHaveCount(1)
    await page.keyboard.press('Delete')
    await expect.poll(() => curveKnots(page).then((ks) => ks.length)).toBe(knots0.length - 1)
    await page.keyboard.press(`${MOD}+z`)
    await expect.poll(() => curveKnots(page).then((ks) => ks.length)).toBe(knots0.length)
  } finally {
    await app.close()
  }
})
