import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 15310
const FORWARD_PORT = 15311
const BEACON_PORT = 15312

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('timeline marquee: drag-select clips, shift adds, click deselects and seeks', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
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
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      duration: 10,
      tracks: [{ clips }, { clips }]
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
    await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
    await expect(page.locator('.clip')).toHaveCount(4)

    const lane = (await page.locator('.track-lane').first().boundingBox())!

    // Drag from the gap between the clips (x 40-80) across both tracks'
    // first clips: rubber-band selects 2, and the marquee rect shows.
    await page.mouse.move(lane.x + 60, lane.y + 10)
    await page.mouse.down()
    await page.mouse.move(lane.x + 20, lane.y + lane.height + 40, { steps: 4 })
    await expect(page.locator('.tl-marquee')).toHaveCount(1)
    await page.mouse.up()
    await expect(page.locator('.tl-marquee')).toHaveCount(0)
    await expect(page.locator('.clip.selected')).toHaveCount(2)

    // Shift-drag over the second clips adds them to the selection.
    await page.keyboard.down('Shift')
    await page.mouse.move(lane.x + 60, lane.y + 10)
    await page.mouse.down()
    await page.mouse.move(lane.x + 100, lane.y + lane.height + 40, { steps: 4 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await expect(page.locator('.clip.selected')).toHaveCount(4)

    // Plain click on empty lane space deselects and seeks (x 60px = 3s).
    await page.mouse.click(lane.x + 60, lane.y + 10)
    await expect(page.locator('.clip.selected')).toHaveCount(0)
    // Playhead left = LABEL_W (96) + 3s * 20px/s = 156.
    await expect(page.locator('.playhead')).toHaveCSS('left', '156px')
  } finally {
    await app.close()
  }
})
