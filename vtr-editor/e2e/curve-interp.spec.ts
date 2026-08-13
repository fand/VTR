import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { curveKnots, curvePoints, expectPropCounts } from './curveHooks'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14450
const FORWARD_PORT = 14451

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
  s?: true
}

test('curve header: value input and interpolation dropdown', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  // A V-shaped /fader ramp: the corner forces the fit to split, so the
  // curve keeps interior knots. /other stays discrete for the point tests.
  const fader = Array.from({ length: 25 }, (_, i) => {
    const t = 0.1 + i * 0.1
    return { t, port: LISTEN_PORT, a: '/fader', args: [Number(Math.abs(t - 1.3).toFixed(4))] }
  })
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      ...fader,
      { t: 0.4, port: LISTEN_PORT, a: '/other', args: [0.2] },
      { t: 2.0, port: LISTEN_PORT, a: '/other', args: [0.8] },
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

    const value = page.locator('input[aria-label="point value"]')
    const interp = page.locator('select[aria-label="interpolation"]')

    await page.locator('.clip').click()
    await expectPropCounts(page, '/fader', 25, 0)
    // Nothing selected: no header editors.
    await expect(value).toHaveCount(0)

    // A discrete point reads as const, and can't take another mode yet.
    const pt = (await curvePoints(page)).find((p) => p.label === '/other' && p.v === 0.2)!
    await page.mouse.click(pt.x, pt.y)
    await expect(interp).toHaveValue('const')
    await expect(interp.locator('option[value="ease-in-out"]')).toHaveJSProperty('disabled', true)
    await expect(value).toHaveValue('0.2')

    // Esc reverts the draft, Enter commits it to the point's event arg.
    await value.fill('0.42')
    await value.press('Escape')
    await expect(value).toHaveValue('0.2')
    await value.fill('0.9')
    await value.press('Enter')
    await expect
      .poll(() =>
        curvePoints(page).then((ps) => ps.find((p) => p.label === '/other' && p.t === pt.t)?.v)
      )
      .toBe(0.9)

    // Fit /fader into one curve, then select all of its knots. The point
    // selection has to go first — it would target the conversion.
    const editor0 = (await page.locator('.curve-editor').boundingBox())!
    await page.mouse.click(editor0.x + 6, editor0.y + editor0.height - 6)
    await expect(value).toHaveCount(0)
    await page.locator('.curve-prop-name', { hasText: '/fader' }).click()
    await page.locator('button[aria-label="replace with curve"]').click()
    await expectPropCounts(page, '/fader', 0, 1)
    const editor = (await page.locator('.curve-editor').boundingBox())!
    const marqueeAll = async (): Promise<void> => {
      await page.mouse.move(editor.x + 4, editor.y + 4)
      await page.mouse.down()
      await page.mouse.move(editor.x + editor.width - 4, editor.y + editor.height - 4, { steps: 5 })
      await page.mouse.up()
    }
    await marqueeAll()
    const knots0 = await curveKnots(page)
    expect(knots0.length).toBeGreaterThanOrEqual(3)
    await expect(page.locator('.curve-knot.selected')).toHaveCount(knots0.length)
    // The fit eases every side that has a segment, so the whole curve reads
    // as one mode; its values differ, so the value input shows its "-".
    await expect(interp).toHaveValue('ease-in-out')
    await expect(value).toHaveValue('')

    // const: every knot but the last steps, and no handle survives.
    await interp.selectOption('const')
    await expect
      .poll(() => curveKnots(page).then((ks) => ks.map((k) => k.s)))
      .toEqual(knots0.map((_, i) => i < knots0.length - 1))
    const stepped = await curveKnots(page)
    expect(stepped.some((k) => k.hasIn || k.hasOut)).toBe(false)
    await expect(interp).toHaveValue('const')
    // Dead sides show no handle affordance: only the last knot's incoming
    // one is live, and its segment steps too — so nothing is draggable.
    await expect(page.locator('.curve-handle')).toHaveCount(0)

    // Back to ease in out: the flags clear and the handles come back on
    // every side that has a segment.
    await interp.selectOption('ease-in-out')
    await expect.poll(() => curveKnots(page).then((ks) => ks.every((k) => !k.s))).toBe(true)
    const eased = await curveKnots(page)
    expect(eased.map((k) => k.hasIn)).toEqual(eased.map((_, i) => i > 0))
    expect(eased.map((k) => k.hasOut)).toEqual(eased.map((_, i) => i < eased.length - 1))
    await expect(interp).toHaveValue('ease-in-out')

    // Re-picking the current mode never resets a dragged handle.
    const sidecar = join(workdir, `${CLIP}.edits.json`)
    const readKnots = (): SidecarKnot[] => {
      try {
        return JSON.parse(readFileSync(sidecar, 'utf8')).curves?.[0]?.knots ?? []
      } catch {
        return []
      }
    }
    // Drop the selection first: with every knot selected the transform box
    // wraps them, and its edges swallow presses on the extreme knots.
    await page.mouse.click(editor.x + 6, editor.y + editor.height - 6)
    await expect(page.locator('.curve-knot.selected')).toHaveCount(0)
    const mid = Math.floor(eased.length / 2)
    await page.mouse.click(eased[mid].x, eased[mid].y)
    await expect(page.locator('.curve-knot.selected')).toHaveCount(1)
    const out = (await page.locator('.curve-handle.out').boundingBox())!
    await page.mouse.move(out.x + out.width / 2, out.y + out.height / 2)
    await page.mouse.down()
    await page.mouse.move(out.x + out.width / 2 + 10, out.y + out.height / 2 - 25, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readKnots()[mid]?.o?.[1] ?? 0).toBeGreaterThan(0.02)
    const dragged = readKnots()[mid].o!
    await interp.selectOption('ease-in-out')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readKnots()[mid]?.o).toEqual(dragged)

    // The value input edits every selected point, several knots of one
    // curve included.
    await marqueeAll()
    const before = (await curveKnots(page)).map((k) => k.v)
    await value.fill('0.5')
    await value.press('Enter')
    await expect.poll(() => curveKnots(page).then((ks) => ks.every((k) => k.v === 0.5))).toBe(true)
    await expect(value).toHaveValue('0.5')
    // One undo entry for the whole edit.
    await page.keyboard.press(`${MOD}+z`)
    await expect.poll(() => curveKnots(page).then((ks) => ks.map((k) => k.v))).toEqual(before)
  } finally {
    await app.close()
  }
})
