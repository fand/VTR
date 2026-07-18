import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14310
const FORWARD_PORT = 14311
const BEACON_PORT = 14312

const CLIP = 'clip-a.jsonl'
const EDITS = {
  set: { 0: { args: { 0: 0.9 } }, 2: { t: 0.2 } },
  del: { 1: true }
}

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

test('edits sidecar: applied on export, survives save round-trip', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.5, port: LISTEN_PORT, a: '/a', args: [0.1] },
      { t: 1.0, port: LISTEN_PORT, a: '/a', args: [0.2] },
      { t: 1.5, port: LISTEN_PORT, a: '/b', args: [0.3] },
      { type: 'session_end', t: 2 }
    ])
  )
  writeFileSync(join(workdir, `${CLIP}.edits.json`), JSON.stringify(EDITS) + '\n')
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

    await page.getByRole('button', { name: 'File' }).click()
    await page.getByRole('button', { name: 'Export' }).click()
    await expect(page.locator('.info-banner')).toContainText('exported')

    // set(args), set(t) + re-sort, and del are all visible in the export.
    const lines = readFileSync(join(workdir, 'session.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const events = lines.filter((l) => !l.type)
    expect(events).toEqual([
      { t: 0.2, port: LISTEN_PORT, a: '/b', args: [0.3] },
      { t: 0.5, port: LISTEN_PORT, a: '/a', args: [0.9] }
    ])

    // The save round-trip (load → Cmd+S) must not lose or inline the overlay.
    await page.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => JSON.parse(readFileSync(join(workdir, `${CLIP}.edits.json`), 'utf8')))
      .toEqual(EDITS)
    const project = JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8'))
    expect(project.edits).toBeUndefined()
    expect(existsSync(join(workdir, `${CLIP}.edits.json`))).toBe(true)
  } finally {
    await app.close()
  }
})
