import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance never collides.
const LISTEN_PORT = 15910
const FORWARD_PORT = 15911

// A clip whose summary line says the recording lost data.
const DAMAGED_CLIP = [
  '{"type":"session_start","wall":"2026-01-01T00:00:00Z"}',
  `{"t":0.2,"port":${LISTEN_PORT},"a":"/fader","args":[0.1]}`,
  `{"t":0.8,"port":${LISTEN_PORT},"a":"/fader","args":[0.9]}`,
  '{"type":"summary","t":1,"events":2,"dropped":3,"write_errors":1,"write_error":"disk full"}',
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
      VTR_TAP_BIN: join(__dirname, '../../vtr-tap/target/debug/vtr-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir
    }
  })
  const page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  return { app, page }
}

test('clip with a lossy summary line loads with a persistent warning', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  const bundle = join(workdir, 'my.oscproj')
  mkdirSync(join(bundle, 'clips'), { recursive: true })
  writeFileSync(join(bundle, 'clips', 'a.jsonl'), DAMAGED_CLIP + '\n')
  writeFileSync(
    join(bundle, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      tracks: [{ clips: [{ file: 'a.jsonl', offset: 0, trimIn: 0, trimOut: 1 }] }]
    })
  )

  const { app, page } = await launch(workdir, bundle)
  try {
    const clip = page.locator('.clip')
    await expect(clip).toHaveCount(1)
    await expect(clip).toHaveClass(/warn/)
    await expect(clip.locator('.clip-warn')).toBeVisible()
    // The summary line itself must not count as an event.
    await expect(page.locator('.clip-meta')).toContainText('2 ev')
    await expect(clip).toHaveAttribute(
      'data-tip',
      'recording lost data: 3 dropped, 1 write failure — disk full'
    )
  } finally {
    await app.close()
  }
})
