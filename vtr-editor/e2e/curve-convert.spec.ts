import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { curveKnots, curvePoints, expectPropCounts } from './curveHooks'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14460
const FORWARD_PORT = 14461

const CLIP = 'clip-a.jsonl'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('discrete points convert into curve knots', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  // Seven /fader points to convert from, plus a single /alone point that has
  // no neighbor element to interpolate with.
  const fader = Array.from({ length: 7 }, (_, i) => ({
    t: 0.2 + i * 0.2,
    port: LISTEN_PORT,
    a: '/fader',
    args: [Number((0.1 + i * 0.1).toFixed(4))]
  }))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      ...fader,
      { t: 1.7, port: LISTEN_PORT, a: '/alone', args: [0.9] },
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
      VTR_TAP_BIN: join(__dirname, '../../target/debug/vtr-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir
    }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })

    const interp = page.locator('select[aria-label="interpolation"]')
    const faderPoints = async (): Promise<{ x: number; y: number; t: number }[]> =>
      (await curvePoints(page)).filter((p) => p.label === '/fader').sort((a, b) => a.t - b.t)

    await page.locator('.clip').click()
    await expectPropCounts(page, '/fader', 7, 0)

    // A point with no neighbor element can only stay const.
    const alone = (await curvePoints(page)).find((p) => p.label === '/alone')!
    await page.mouse.click(alone.x, alone.y)
    await expect(interp).toHaveValue('const')
    await expect(interp.locator('option[value="ease-in-out"]')).toHaveJSProperty('disabled', true)

    // One selected point pulls in a neighbor on each side: three knots, the
    // selected one eased, the pulled-in ends plain.
    const pts = await faderPoints()
    await page.mouse.click(pts[3].x, pts[3].y)
    await expect(interp.locator('option[value="ease-in-out"]')).toHaveJSProperty('disabled', false)
    await interp.selectOption('ease-in-out')
    await expectPropCounts(page, '/fader', 4, 1)
    const knots = await curveKnots(page)
    expect(knots.map((k) => Number(k.t.toFixed(3)))).toEqual([0.6, 0.8, 1])
    expect(knots.map((k) => k.hasIn)).toEqual([false, true, false])
    expect(knots.map((k) => k.hasOut)).toEqual([false, true, false])
    expect(knots.every((k) => !k.s)).toBe(true)

    // One undo entry brings the points back.
    await page.keyboard.press(`${MOD}+z`)
    await expectPropCounts(page, '/fader', 7, 0)

    // Two selected points around a third: one curve, five knots (the
    // in-between point absorbed as a plain knot).
    const again = await faderPoints()
    await page.mouse.click(again[2].x, again[2].y)
    await page.keyboard.down('Shift')
    await page.mouse.click(again[4].x, again[4].y)
    await page.keyboard.up('Shift')
    await expect(page.locator('.curve-point.selected')).toHaveCount(2)
    await interp.selectOption('ease-in-out')
    await expectPropCounts(page, '/fader', 2, 1)
    const merged = await curveKnots(page)
    expect(merged.map((k) => Number(k.t.toFixed(3)))).toEqual([0.4, 0.6, 0.8, 1, 1.2])
    // The middle (unselected) knot stays plain; the selected ones are eased.
    expect(merged.map((k) => k.hasIn)).toEqual([false, true, false, true, false])
  } finally {
    await app.close()
  }
})
