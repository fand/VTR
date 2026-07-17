import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance never collides.
const LISTEN_PORT = 15510
const FORWARD_PORT = 15511
const BEACON_PORT = 15512

const CLIP = [
  '{"type":"session_start","wall":"2026-01-01T00:00:00Z"}',
  '{"t":0.2,"port":15510,"a":"/fader","args":[0.1]}',
  '{"t":0.8,"port":15510,"a":"/fader","args":[0.9]}',
  '{"type":"session_end","t":1}'
].join('\n')

async function launch(
  workdir: string,
  bundle: string
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js'), bundle],
    cwd: workdir,
    env: {
      ...process.env,
      OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir
    }
  })
  const page = await app.firstWindow()
  await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
  return { app, page }
}

test('missing clip: kept grayed, save keeps the reference, restore brings it back', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  const bundle = join(workdir, 'my.oscproj')
  mkdirSync(join(bundle, 'clips'), { recursive: true })
  writeFileSync(join(bundle, 'clips', 'a.jsonl'), CLIP + '\n')
  writeFileSync(
    join(bundle, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      tracks: [{ clips: [{ file: 'a.jsonl', offset: 1, trimIn: 0, trimOut: 1 }] }]
    })
  )
  // Make the referenced clip unreadable (simulates external delete/corruption).
  renameSync(join(bundle, 'clips', 'a.jsonl'), join(bundle, 'clips', 'a.jsonl.bak'))

  const { app, page } = await launch(workdir, bundle)
  try {
    // The clip stays on the track, grayed out, and the banner names it.
    await expect(page.locator('.clip.missing')).toHaveCount(1)
    await expect(page.locator('.clip-meta')).toContainText('missing file')
    await expect(page.locator('.error-banner')).toContainText('a.jsonl')

    // Save must round-trip the reference, not drop it.
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => page.title()).toBe('osc-mtr - my.oscproj')
    const saved = JSON.parse(readFileSync(join(bundle, 'project.json'), 'utf8'))
    expect(saved.tracks[0].clips).toHaveLength(1)
    expect(saved.tracks[0].clips[0]).toMatchObject({ file: 'a.jsonl', offset: 1 })
  } finally {
    await app.close()
  }

  // Restore the file and reopen: the clip is back, fully readable.
  renameSync(join(bundle, 'clips', 'a.jsonl.bak'), join(bundle, 'clips', 'a.jsonl'))
  const { app: app2, page: page2 } = await launch(workdir, bundle)
  try {
    await expect(page2.locator('.clip')).toHaveCount(1)
    await expect(page2.locator('.clip.missing')).toHaveCount(0)
    await expect(page2.locator('.clip-meta')).toContainText('2 ev')
  } finally {
    await app2.close()
  }
})
