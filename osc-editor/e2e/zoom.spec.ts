import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14710
const FORWARD_PORT = 14711
const BEACON_PORT = 14712

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('timeline pinch zoom (ctrl+wheel) scales around the cursor', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.5, port: LISTEN_PORT, a: '/a', args: [0.1] },
      { type: 'session_end', t: 2 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      duration: 10,
      tracks: [{ clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 2 }] }]
    })
  )

  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js')],
    cwd: workdir,
    env: {
      ...process.env,
      OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
      OSC_EDITOR_HIDDEN: '1'
    }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })

    const width = async (): Promise<number> => (await page.locator('.clip').boundingBox())!.width

    const before = await width()
    const pinch = (deltaY: number): Promise<void> =>
      page.locator('.timeline-scroll').evaluate((el, dy) => {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: dy,
            ctrlKey: true,
            clientX: 300,
            clientY: 100,
            bubbles: true,
            cancelable: true
          })
        )
      }, deltaY)

    // Pinch out (deltaY < 0) zooms in.
    await pinch(-100)
    await expect.poll(width).toBeGreaterThan(before * 2)

    // Pinch in zooms back out.
    await pinch(200)
    await expect.poll(width).toBeLessThan(before * 1.2)

    // Curve editor zooms its time axis the same way, anchored at the pointer.
    await page.locator('.clip').click()
    const svg = page.locator('.curve-scroll svg')
    const svgWidth = async (): Promise<number> => Number(await svg.getAttribute('width'))
    const svgBefore = await svgWidth()
    const editorBox = (await page.locator('.curve-editor').boundingBox())!
    const clientX = editorBox.x + 300
    // Normalized time position under the cursor (PAD = 10).
    const norm = (): Promise<number> =>
      page.locator('.curve-scroll').evaluate((el, x) => {
        const rect = el.getBoundingClientRect()
        return (el.scrollLeft + (x - rect.left) - 10) / (el.scrollWidth - 20)
      }, clientX)
    const normBefore = await norm()
    // Two events in one tick: pinch outruns re-renders, both must compound.
    await page.locator('.curve-editor').evaluate((el, x) => {
      for (let i = 0; i < 2; i++) {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -100,
            ctrlKey: true,
            clientX: x,
            clientY: 500,
            bubbles: true,
            cancelable: true
          })
        )
      }
    }, clientX)
    // e^2 ≈ 7.4× — a single applied event (e ≈ 2.7×) fails this.
    await expect.poll(svgWidth).toBeGreaterThan(svgBefore * 6)
    // The time under the cursor stays put.
    expect(await norm()).toBeCloseTo(normBefore, 2)
  } finally {
    await app.close()
  }
})
