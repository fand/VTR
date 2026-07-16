import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 14610
const FORWARD_PORT = 14611
const BEACON_PORT = 14612

const CLIP = 'clip-a.jsonl'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function savedProject(workdir: string): {
  tracks: { name?: string; clips: { name?: string }[] }[]
} {
  return JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8'))
}

test('track rename: double-click, persisted, undoable', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  writeFileSync(
    join(workdir, CLIP),
    jsonl([
      { type: 'session_start', t: 0, wall: '2026-07-16T00:00:00Z' },
      { t: 0.5, port: LISTEN_PORT, a: '/a', args: [0.1] },
      { type: 'session_end', t: 1 }
    ])
  )
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      duration: 10,
      tracks: [{ clips: [{ file: CLIP, offset: 0, trimIn: 0, trimOut: 1 }] }]
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

    const label = page.locator('.track-label .editable-label')
    await expect(label).toHaveText('Track 1')
    await label.dblclick()
    await page.locator('.rename-input').fill('Drums')
    await page.keyboard.press('Enter')
    await expect(label).toHaveText('Drums')
    await expect.poll(() => savedProject(workdir).tracks[0].name).toBe('Drums')

    // Escape cancels.
    await label.dblclick()
    await page.locator('.rename-input').fill('Nope')
    await page.keyboard.press('Escape')
    await expect(label).toHaveText('Drums')

    // Rename is one undo entry.
    await page.keyboard.press(`${MOD}+z`)
    await expect(label).toHaveText('Track 1')
    await expect.poll(() => savedProject(workdir).tracks[0].name).toBeUndefined()

    // Clip rename works the same way and persists per placement.
    const clipLabel = page.locator('.clip .editable-label')
    await expect(clipLabel).toHaveText(CLIP)
    await clipLabel.dblclick()
    await page.locator('.rename-input').fill('Kick')
    await page.keyboard.press('Enter')
    await expect(clipLabel).toHaveText('Kick')
    await expect.poll(() => savedProject(workdir).tracks[0].clips[0].name).toBe('Kick')
    await page.keyboard.press(`${MOD}+z`)
    await expect(clipLabel).toHaveText(CLIP)
  } finally {
    await app.close()
  }
})
