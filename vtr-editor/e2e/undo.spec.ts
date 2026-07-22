import { _electron as electron, ElectronApplication, expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14510
const FORWARD_PORT = 14511

const CLIP = 'clip-a.jsonl'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function launch(workdir: string, projectPath?: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(__dirname, '../out/main/index.js'), projectPath ?? join(workdir, 'project.json')],
    cwd: workdir,
    env: {
      ...process.env,
      VTR_TAP_BIN: join(__dirname, '../../vtr-tap/target/debug/vtr-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir
    }
  })
}

function savedOffset(workdir: string): number {
  return JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8')).tracks[0].clips[0].offset
}

function savedSeq(workdir: string): number | undefined {
  return JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8')).undoSeq
}

test('undo/redo: one entry per drag, survives restart, linear truncation', async () => {
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

  let app = await launch(workdir)
  let page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })

  // Drag the clip +100px = +5s at 20px/s → one undo entry.
  const dragClip = async (px: number): Promise<void> => {
    const box = (await page.locator('.clip').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + px, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
  }
  await dragClip(100)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(4)
  await expect.poll(() => savedSeq(workdir)).toBe(1)

  // In-session undo and redo via keyboard.
  await page.keyboard.press(`${MOD}+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeLessThan(1)
  await expect.poll(() => savedSeq(workdir)).toBe(0)
  await page.keyboard.press(`${MOD}+Shift+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(4)
  await expect.poll(() => savedSeq(workdir)).toBe(1)

  // Undo survives a restart.
  await app.close()
  app = await launch(workdir)
  page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  await expect.poll(async () => (await page.locator('.clip').boundingBox())!.x).toBeGreaterThan(100)
  await page.keyboard.press(`${MOD}+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeLessThan(1)

  // A new edit after undo truncates the redo branch (linear history).
  await dragClip(40)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(1.5)
  const offsetAfter = savedOffset(workdir)
  await page.keyboard.press(`${MOD}+Shift+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(400)
  expect(savedOffset(workdir)).toBe(offsetAfter)
  const seqs = readFileSync(join(workdir, 'undo.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).seq)
  expect(seqs).toEqual([2])

  await app.close()
})

test('redo survives a relaunch: entries past undoSeq become the redo stack', async () => {
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
      duration: 20,
      tracks: [{ clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 2 }] }]
    })
  )

  let app = await launch(workdir)
  let page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  const dragClip = async (px: number): Promise<void> => {
    const box = (await page.locator('.clip').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + px, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
  }

  // Two entries (offset 0 → 5 → 10), undo one, save: undoSeq = 1 while the
  // log keeps seq 2 — the crash-recovery shape.
  await dragClip(100)
  await dragClip(100)
  await page.keyboard.press(`${MOD}+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedSeq(workdir)).toBe(1)
  await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(4)
  await app.close()

  // Relaunch: seq 2 must come back as redo.
  app = await launch(workdir)
  page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  await page.keyboard.press(`${MOD}+Shift+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(9)
  await expect.poll(() => savedSeq(workdir)).toBe(2)
  await app.close()
})

test('divergent undo entry drops history and says so in the banner', async () => {
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
      undoSeq: 1,
      tracks: [{ clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 2 }] }]
    })
  )
  // An entry whose inverse patch points at a track that doesn't exist:
  // applyPatches must throw, wiping the stack instead of corrupting the doc.
  writeFileSync(
    join(workdir, 'undo.jsonl'),
    jsonl([
      {
        seq: 1,
        label: 'bogus',
        patches: [{ op: 'replace', path: ['tracks', 5, 'clips', 0, 'offset'], value: 5 }],
        inversePatches: [{ op: 'replace', path: ['tracks', 5, 'clips', 0, 'offset'], value: 0 }]
      }
    ])
  )

  const app = await launch(workdir)
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.keyboard.press(`${MOD}+z`)
    await expect(page.locator('.error-banner')).toContainText('history')
    // The log is truncated and the doc untouched.
    await expect.poll(() => readFileSync(join(workdir, 'undo.jsonl'), 'utf8').trim()).toBe('')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => savedOffset(workdir)).toBe(0)
  } finally {
    await app.close()
  }
})

test('undo log stays with its project: opening A never replays B', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  // Two projects in separate dirs, one shared data dir (workdir).
  const project = (offset: number): string =>
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      tracks: [{ clips: [{ file: CLIP, offset, trimIn: 0, trimOut: 2 }] }]
    })
  for (const [name, offset] of [
    ['a', 2],
    ['b', 0]
  ] as const) {
    mkdirSync(join(workdir, name))
    writeFileSync(
      join(workdir, name, CLIP),
      jsonl([
        { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
        { t: 0.5, port: LISTEN_PORT, a: '/a', args: [0.1] },
        { type: 'session_end', t: 2 }
      ])
    )
    writeFileSync(join(workdir, name, 'project.json'), project(offset))
  }

  // Edit and save B → one undo entry in B's log.
  let app = await launch(workdir, join(workdir, 'b', 'project.json'))
  let page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  const box = (await page.locator('.clip').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedSeq(join(workdir, 'b'))).toBe(1)
  await app.close()

  // The log lives in B's dir, not the shared data dir.
  expect(existsSync(join(workdir, 'b', 'undo.jsonl'))).toBe(true)
  expect(existsSync(join(workdir, 'undo.jsonl'))).toBe(false)

  // Open A: Cmd+Z must be a no-op, not apply B's inverse patches to A.
  app = await launch(workdir, join(workdir, 'a', 'project.json'))
  page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  await page.keyboard.press(`${MOD}+z`)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => savedSeq(join(workdir, 'a'))).toBe(0)
  expect(savedOffset(join(workdir, 'a'))).toBe(2)

  await app.close()
})

test('undo mid-drag is ignored; the gesture and the stack survive', async () => {
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
      duration: 20,
      tracks: [{ clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 2 }] }]
    })
  )

  const app = await launch(workdir)
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    const save = (): Promise<void> => page.keyboard.press('ControlOrMeta+s')

    // First drag commits one entry: offset 0 → 5 (+100px at 20px/s).
    let box = (await page.locator('.clip').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
    await save()
    await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(4)

    // Second drag: Cmd+Z fires while the pointer is still down. It must be
    // a no-op — the drag finishes normally at offset 10.
    box = (await page.locator('.clip').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 })
    await page.keyboard.press(`${MOD}+z`)
    await page.mouse.up()
    await save()
    await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(9)

    // The stack is intact: two undos walk 10 → 5 → 0, redo returns to 5.
    await page.keyboard.press(`${MOD}+z`)
    await save()
    await expect.poll(() => savedOffset(workdir)).toBeLessThan(6)
    await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(4)
    await page.keyboard.press(`${MOD}+z`)
    await save()
    await expect.poll(() => savedOffset(workdir)).toBeLessThan(1)
    await page.keyboard.press(`Shift+${MOD}+z`)
    await save()
    await expect.poll(() => savedOffset(workdir)).toBeGreaterThan(4)
  } finally {
    await app.close()
  }
})
