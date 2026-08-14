import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectPointCount } from './curveHooks'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 16310
const FORWARD_PORT = 16311

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

const ENV = {
  ...process.env,
  VTR_TAP_BIN: join(__dirname, '../../target/debug/vtr-tap'),
  OSC_EDITOR_HIDDEN: '1'
}

test('select all: Cmd+A selects every clip with the timeline focused', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.1] },
      { type: 'session_end', t: 2 }
    ])
  )
  // Two tracks, two clips each: 0-40px and 80-120px per lane at 20 px/s.
  const clips = [
    { file: CLIP, offset: 0, trimIn: 0, trimOut: 2 },
    { file: CLIP, offset: 4, trimIn: 0, trimOut: 2 }
  ]
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      tracks: [{ clips }, { clips }]
    })
  )

  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js'), join(workdir, 'project.json')],
    cwd: workdir,
    env: { ...ENV, OSC_EDITOR_DATA_DIR: workdir }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await expect(page.locator('.clip')).toHaveCount(4)

    // Click empty lane space: nothing selected, and the timeline has focus.
    await page
      .locator('.track-lane')
      .first()
      .click({ position: { x: 500, y: 10 } })
    await expect(page.locator('.clip.selected')).toHaveCount(0)

    // Cmd+A takes every clip of every track, across both lanes.
    await page.keyboard.press('ControlOrMeta+a')
    await expect(page.locator('.clip.selected')).toHaveCount(4)
    await expect(page.locator('.status-bar')).toContainText('4 clips')

    // The selection is a real clip selection: Delete removes all of them.
    await page.keyboard.press('Backspace')
    await expect(page.locator('.clip')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.clip')).toHaveCount(4)
  } finally {
    await app.close()
  }
})

test('select all: Cmd+A in the curve pane takes curves, then their points', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.1] },
      { t: 0.5, port: LISTEN_PORT, a: '/xy', args: [0.1, 0.2] },
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
    env: { ...ENV, OSC_EDITOR_DATA_DIR: workdir }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.locator('.clip').click()
    await expect(page.locator('.curve-prop-name')).toHaveText(['/fader', '/xy[0]', '/xy[1]'])
    // 3 fader + 2×2 xy.
    await expectPointCount(page, 7)

    // Empty editor space, well above every curve: clears any selection and
    // moves pane focus to the curve panel.
    const editor = (await page.locator('.curve-editor').boundingBox())!
    const empty = { x: editor.x + 8, y: editor.y + 8 }
    await page.mouse.click(empty.x, empty.y)
    await expect(page.locator('.curve-prop.selected')).toHaveCount(0)

    // First Cmd+A: every curve row. Second: every point of those curves.
    await page.keyboard.press('ControlOrMeta+a')
    await expect(page.locator('.curve-prop.selected')).toHaveCount(3)
    await expect(page.locator('circle.selected')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+a')
    await expect(page.locator('circle.selected')).toHaveCount(7)
    await expect(page.locator('.status-bar')).toContainText('7 points')
    // Curve points, not clips: the clip selection is untouched.
    await expect(page.locator('.clip.selected')).toHaveCount(1)

    // The filter narrows what Cmd+A can reach. Leave the input first, so the
    // keypress goes to the pane and not to the text field.
    await page.mouse.click(empty.x, empty.y)
    await expect(page.locator('.curve-prop.selected')).toHaveCount(0)
    await page.getByLabel('filter properties').fill('xy')
    await expect(page.locator('.curve-prop-name')).toHaveText(['/xy[0]', '/xy[1]'])
    await page.mouse.click(empty.x, empty.y)
    await page.keyboard.press('ControlOrMeta+a')
    await expect(page.locator('.curve-prop.selected')).toHaveText([/\/xy\[0\]/, /\/xy\[1\]/])

    // Clearing the filter brings /fader back unselected: it never got picked.
    await page.getByLabel('filter properties').fill('')
    await expect(page.locator('.curve-prop-name')).toHaveCount(3)
    await expect(page.locator('.curve-prop.selected')).toHaveCount(2)

    // Cmd+A inside the filter input is the field's own select-all: app
    // selection state stays put.
    await page.getByLabel('filter properties').click()
    await page.keyboard.press('ControlOrMeta+a')
    await expect(page.locator('.curve-prop.selected')).toHaveCount(2)
    await expect(page.locator('circle.selected')).toHaveCount(0)
    await expect(page.locator('.clip.selected')).toHaveCount(1)
  } finally {
    await app.close()
  }
})
