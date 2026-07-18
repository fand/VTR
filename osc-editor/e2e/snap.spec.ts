import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 15110
const FORWARD_PORT = 15111
const BEACON_PORT = 15112

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test("snap toggle: clip move and trim snap to other clips' edges", async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.2, port: LISTEN_PORT, a: '/fader', args: [0.1] },
      { type: 'session_end', t: 2 }
    ])
  )
  // Clip A ends at 2s (40px at 20 px/s); clip B starts at 4s.
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      duration: 10,
      tracks: [
        {
          clips: [
            { file: CLIP, offset: 0, trimIn: 0, trimOut: 2 },
            { file: CLIP, offset: 4, trimIn: 0, trimOut: 2 }
          ]
        }
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

    const left = (i: number): Promise<number> =>
      page
        .locator('.clip')
        .nth(i)
        .evaluate((el) => parseFloat((el as HTMLElement).style.left))

    const dragClipB = async (dxPx: number): Promise<void> => {
      const box = (await page.locator('.clip').nth(1).boundingBox())!
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      await page.mouse.move(cx + dxPx, cy, { steps: 4 })
      await page.mouse.up()
    }

    // Snap off: a drag to ~2.25s (5px short of touching) stays put.
    await dragClipB(-35)
    expect(await left(1)).toBeCloseTo(45, 0)

    // Snap on: the same 5px gap locks B's head onto A's tail (2s → 40px).
    // Scoped to the timeline header: the curve editor has its own Snap button.
    const snapBtn = page.locator('.tl-header').getByRole('button', { name: 'Snap' })
    await snapBtn.click()
    await expect(snapBtn).toHaveAttribute('aria-pressed', 'true')
    await dragClipB(-4)
    expect(await left(1)).toBe(40)

    // Toggle off: the same near-miss drag no longer snaps.
    await snapBtn.click()
    await expect(snapBtn).toHaveAttribute('aria-pressed', 'false')
    await dragClipB(35)
    expect(await left(1)).toBeCloseTo(75, 0)
  } finally {
    await app.close()
  }
})
