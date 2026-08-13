import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { curvePoints } from './curveHooks'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14710
const FORWARD_PORT = 14711

const CLIP = 'clip-a.jsonl'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('timeline pinch zoom (ctrl+wheel) scales around the cursor', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
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
    const svg = page.locator('.curve-scroll svg.curve-under')
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

test('curve editor x/y zoom sliders scale the axes; y zoom scrolls vertically', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.5, port: LISTEN_PORT, a: '/a', args: [0.1] },
      { t: 1.5, port: LISTEN_PORT, a: '/a', args: [0.9] },
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
    await page.locator('.clip').click()

    const svg = page.locator('.curve-scroll svg.curve-under')
    await expect(svg).toBeVisible()
    const w0 = Number(await svg.getAttribute('width'))
    const h0 = Number(await svg.getAttribute('height'))

    // X slider widens the svg (50 → 50^0.5 ≈ 7×).
    await page.getByLabel('x zoom').fill('50')
    await expect.poll(async () => Number(await svg.getAttribute('width'))).toBeGreaterThan(w0 * 5)

    // Y slider grows the svg height and the editor scrolls vertically.
    await page.getByLabel('y zoom').fill('50')
    await expect.poll(async () => Number(await svg.getAttribute('height'))).toBeGreaterThan(h0 * 5)
    const overflow = (): Promise<number> =>
      page.locator('.curve-scroll').evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(await overflow()).toBeGreaterThan(100)

    // Back to 1×: no vertical overflow. Reset x too — on machines with
    // always-visible scrollbars (e.g. mouseless CI runners) a horizontal
    // bar would eat ~15px of clientHeight and read as vertical overflow.
    await page.getByLabel('y zoom').fill('0')
    await page.getByLabel('x zoom').fill('0')
    await expect.poll(overflow).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
  }
})

test('curve editor fit zoom fits all points, then the selected point', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  // Points span 1s of a 10s clip → fit zoom ≈ 9.8×.
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 4.5, port: LISTEN_PORT, a: '/a', args: [0.1] },
      { t: 5.5, port: LISTEN_PORT, a: '/a', args: [0.9] },
      { type: 'session_end', t: 10 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      tracks: [{ clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 10 }] }]
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

    const svg = page.locator('.curve-scroll svg.curve-under')
    await expect(svg).toBeVisible()
    const svgWidth = async (): Promise<number> => Number(await svg.getAttribute('width'))
    const w0 = await svgWidth()

    // No selection: fit all points. 1s of 10s → ~9.8×, scrolled to the middle.
    await page.getByLabel('fit zoom').click()
    await expect.poll(svgWidth).toBeGreaterThan(w0 * 8)
    const scrollLeft = (): Promise<number> =>
      page.locator('.curve-scroll').evaluate((el) => el.scrollLeft)
    expect(await scrollLeft()).toBeGreaterThan(0)

    // The points span the viewport width (minus PAD on each side).
    const viewW = await page.locator('.curve-scroll').evaluate((el) => el.clientWidth)
    const xs = (await curvePoints(page)).map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(viewW - 25)

    // Select one point: fit clamps to max zoom (50×) and centers on it.
    const pt = (await curvePoints(page))[0]
    await page.mouse.click(pt.x, pt.y)
    await expect.poll(() => curvePoints(page).then((p) => p[0]?.selected)).toBe(true)
    await page.getByLabel('fit zoom').click()
    await expect.poll(svgWidth).toBeGreaterThan(w0 * 45)
    const editor = (await page.locator('.curve-editor').boundingBox())!
    const sel = (await curvePoints(page)).find((p) => p.selected)!
    expect(Math.abs(sel.x - (editor.x + editor.width / 2))).toBeLessThan(5)
  } finally {
    await app.close()
  }
})

test('dragging the last clip left keeps the view range, drag distance, and undo', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.5, port: LISTEN_PORT, a: '/a', args: [0.1] },
      { type: 'session_end', t: 100 }
    ])
  )
  // Clip recorded far past the stale 10s duration (the tl-align case): the
  // view extent comes from the clip, and the timeline is long enough that
  // min zoom sits below 2px/s. A mid-drag extent shrink would then refit
  // the zoom under the cursor: the clip lags the pointer, the width jumps,
  // and undo can't restore the view.
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      tracks: [{ clips: [{ file: CLIP, offset: 2000, trimIn: 0, trimOut: 100 }] }]
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

    // Min zoom: the whole 2100s fits, the clip is on screen.
    await page.getByLabel('zoom', { exact: true }).fill('0')
    const scrollWidth = (): Promise<number> =>
      page.locator('.timeline-scroll').evaluate((el) => el.scrollWidth)
    const clipX = async (): Promise<number> => (await page.locator('.clip').boundingBox())!.x
    await expect
      .poll(() => page.locator('.timeline-scroll').evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1)
    const width0 = await scrollWidth()
    const x0 = await clipX()

    // Drag the clip 300px left.
    const box = (await page.locator('.clip').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 300, box.y + box.height / 2, { steps: 10 })
    // Mid-drag: the view extent must not shrink.
    expect(await scrollWidth()).toBe(width0)
    await page.mouse.up()

    // The clip moved by the dragged distance, and the extent is unchanged.
    await expect.poll(clipX).toBeLessThan(x0 - 290)
    await expect.poll(clipX).toBeGreaterThan(x0 - 310)
    expect(await scrollWidth()).toBe(width0)

    // Undo restores the position and the extent.
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(clipX).toBeGreaterThan(x0 - 2)
    await expect.poll(clipX).toBeLessThan(x0 + 2)
    expect(await scrollWidth()).toBe(width0)
  } finally {
    await app.close()
  }
})

test('min zoom fits a long timeline in the window', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
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
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 2400, // 40 min: 2px/s alone can't fit this in the window
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

    // Slider to minimum → the whole 40-min timeline fits, no horizontal scroll.
    // exact: the curve editor has its own "x zoom" / "y zoom" sliders.
    await page.getByLabel('zoom', { exact: true }).fill('0')
    await expect
      .poll(() =>
        page.locator('.timeline-scroll').evaluate((el) => el.scrollWidth - el.clientWidth)
      )
      .toBeLessThanOrEqual(1)
  } finally {
    await app.close()
  }
})

test('pinch zoom-out keeps the time under the cursor when the width shrink clamps the scroll', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
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

    const scroll = page.locator('.timeline-scroll')
    // Max zoom → 10s at 1440px/s = 14500px wide (incl. 100px tail pad).
    await page.getByLabel('zoom', { exact: true }).fill('100')
    await expect.poll(() => scroll.evaluate((el) => el.scrollWidth)).toBeGreaterThan(14_000)
    // Scroll into the middle: a zoom-out from here shrinks the content below
    // scrollLeft + viewport, so the browser clamps scrollLeft mid-commit.
    await scroll.evaluate((el) => (el.scrollLeft = 6000))

    // Timeline seconds under viewport-x 300 (LABEL_W = 96, TAIL_PAD = 100).
    const timeUnder = (): Promise<number> =>
      scroll.evaluate((el) => {
        const px = (el.scrollWidth - 100) / 10
        return (el.scrollLeft + 300 - 96) / px
      })
    const before = await timeUnder()

    await scroll.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: 100, // pinch in: zoom out by e ≈ 2.7×
          ctrlKey: true,
          clientX: rect.left + 300,
          clientY: rect.top + 50,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await expect.poll(() => scroll.evaluate((el) => el.scrollWidth)).toBeLessThan(6000)
    expect(await timeUnder()).toBeCloseTo(before, 1)
  } finally {
    await app.close()
  }
})
