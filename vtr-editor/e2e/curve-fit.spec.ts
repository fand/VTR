import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { curveKnots, expectPropCounts } from './curveHooks'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14430
const FORWARD_PORT = 14431

const CLIP = 'clip-a.jsonl'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('replace with curve: fit, undo/redo, sidecar persistence', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  // A dense /fader ramp (25 samples of a gentle parabola) plus an /other
  // property that must survive the conversion untouched.
  const fader = Array.from({ length: 25 }, (_, i) => {
    const t = 0.1 + i * 0.1
    return { t, port: LISTEN_PORT, a: '/fader', args: [Number((t * t * 0.15).toFixed(4))] }
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

    await page.locator('.clip').click()
    await expectPropCounts(page, '/fader', 25, 0)

    // No selection yet: the button is disabled.
    const button = page.locator('button[aria-label="replace with curve"]')
    await expect(button).toBeDisabled()

    // Selecting the property arms it; converting swaps points for a curve.
    await page.locator('.curve-prop-name', { hasText: '/fader' }).click()
    await expect(button).toBeEnabled()
    await button.click()
    await expectPropCounts(page, '/fader', 0, 1)
    await expectPropCounts(page, '/other', 2, 0)

    // The fitted curve spans the points and keeps the endpoint values.
    const knots = await curveKnots(page)
    expect(knots.length).toBeGreaterThanOrEqual(2)
    expect(knots[0].t).toBeCloseTo(0.1, 5)
    expect(knots[knots.length - 1].t).toBeCloseTo(2.5, 5)
    expect(knots[0].v).toBeCloseTo(0.0015, 3)
    expect(knots[knots.length - 1].v).toBeCloseTo(0.9375, 2)

    // One undo entry: points come back, the curve goes away. Redo re-applies.
    await page.keyboard.press(`${MOD}+z`)
    await expectPropCounts(page, '/fader', 25, 0)
    await page.keyboard.press(`${MOD}+Shift+z`)
    await expectPropCounts(page, '/fader', 0, 1)

    // Save persists the overlay: deletes for the covered events, the fitted
    // curve in the sidecar.
    await page.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(join(workdir, `${CLIP}.edits.json`), 'utf8'))
        } catch {
          return null
        }
      })
      .toMatchObject({ curves: [{ a: '/fader', arg: 0 }] })
    const edits = JSON.parse(readFileSync(join(workdir, `${CLIP}.edits.json`), 'utf8'))
    expect(Object.keys(edits.del)).toHaveLength(25)
    expect(edits.curves[0].knots.length).toBe(knots.length)
  } finally {
    await app.close()
  }
})
