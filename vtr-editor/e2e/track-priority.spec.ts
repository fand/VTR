import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { curvePoints } from './curveHooks'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14470
const FORWARD_PORT = 14471

const UPPER = 'clip-upper.jsonl'
const LOWER = 'clip-lower.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

// The lower track wins (docs/tasks/track-priority): the curve editor draws the
// upper track's points inside a lower clip's window as masked. Merge semantics
// are unit-tested; this pins the UI wiring.
test('lower track masks the upper track in the curve editor', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, UPPER),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      ...[0.4, 1.4, 2.4, 3.4].map((t) => ({ t, port: LISTEN_PORT, a: '/fader', args: [t / 10] })),
      { type: 'session_end', t: 4 }
    ])
  )
  writeFileSync(
    join(workdir, LOWER),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.5, port: LISTEN_PORT, a: '/fader', args: [0.9] },
      { type: 'session_end', t: 2 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      // Upper track spans 0..4; the lower clip owns /fader over 1..3.
      tracks: [
        { clips: [{ file: UPPER, offset: 0, trimIn: 0, trimOut: 4 }] },
        { clips: [{ file: LOWER, offset: 1, trimIn: 0, trimOut: 2 }] }
      ]
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

    const maskedFlags = (): Promise<boolean[]> =>
      curvePoints(page).then((pts) => pts.sort((a, b) => a.t - b.t).map((p) => p.masked))
    const expectMasked = (flags: boolean[]): Promise<void> =>
      expect.poll(maskedFlags).toEqual(flags)

    // The upper clip's points inside the lower clip's window read masked.
    await page.locator('.clip').first().click()
    await expectMasked([false, true, true, false])

    // A muted clip masks nothing.
    await page.locator('.clip').nth(1).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mute' }).click()
    await expect(page.locator('.clip.muted')).toHaveCount(1)
    await page.locator('.clip').first().click()
    await expectMasked([false, false, false, false])

    // Unmuting brings the mask back.
    await page.locator('.clip').nth(1).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Unmute' }).click()
    await expect(page.locator('.clip.muted')).toHaveCount(0)
    await page.locator('.clip').first().click()
    await expectMasked([false, true, true, false])

    // The bottom track is never masked.
    await page.locator('.clip').nth(1).click()
    await expectMasked([false])
  } finally {
    await app.close()
  }
})
