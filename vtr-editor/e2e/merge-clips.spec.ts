import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 16110
const FORWARD_PORT = 16111

const UPPER = 'clip-upper.jsonl'
const LOWER = 'clip-lower.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

// Merge bakes what playback resolves for the selected clips into one new clip
// file, so the export must not change. Merge semantics are unit-tested
// (src/main/mergeClip.test.ts); this pins the UI wiring, undo, and save.
test('merge: two tracks into one clip, export unchanged, undo/redo, save', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  const bundle = join(workdir, 'merged.oscproj')
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
      OSC_EDITOR_DATA_DIR: workdir,
      OSC_EDITOR_DIALOG_PATH: bundle
    }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })

    // Everything but session_start, whose wall clock moves per export.
    const exported = async (): Promise<unknown[]> => {
      await page.getByRole('button', { name: 'File' }).click()
      await page.getByRole('button', { name: 'Export' }).click()
      await expect(page.locator('.sb-log')).toContainText('Exported')
      return readFileSync(join(workdir, 'session.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.type !== 'session_start')
    }

    const before = await exported()
    // The mask drops one upper event and adds a resume after the take.
    expect(before.filter((l) => !(l as { type?: string }).type)).toHaveLength(4)

    // Select both clips; the menu acts on the whole selection.
    await page.locator('.clip').first().click()
    await page
      .locator('.clip')
      .nth(1)
      .click({ modifiers: ['Shift'] })
    await expect(page.locator('.clip.selected')).toHaveCount(2)
    await page.locator('.clip').first().click({ button: 'right' })
    await expect(page.getByRole('menuitem')).toHaveCount(7)
    await page.getByRole('menuitem', { name: 'Merge' }).click()

    // One clip left, on the bottom-most selected track (the one that won).
    await expect(page.locator('.clip')).toHaveCount(1)
    await expect(page.locator('.track').nth(1).locator('.clip')).toHaveCount(1)
    await expect(page.locator('.clip')).toContainText('Merged')
    await expect(page.locator('.clip.selected')).toHaveCount(1)

    // Playback resolves the same: the baked clip replays what the stack did.
    expect(await exported()).toEqual(before)

    // One undo entry for the whole merge.
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.clip')).toHaveCount(2)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(page.locator('.clip')).toHaveCount(1)

    // Save As: the project references the merged clip and the bundle owns it.
    await page.keyboard.press('ControlOrMeta+Shift+s')
    await expect.poll(() => page.title()).toBe('VTR - merged.oscproj')
    const saved = JSON.parse(readFileSync(join(bundle, 'project.json'), 'utf8'))
    const files = saved.tracks.flatMap((t: { clips: { file: string }[] }) =>
      t.clips.map((c) => c.file)
    )
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^merged-\d{8}-\d{6}(-\d+)?\.jsonl$/)
    expect(existsSync(join(bundle, 'clips', files[0]))).toBe(true)
  } finally {
    await app.close()
  }
})
