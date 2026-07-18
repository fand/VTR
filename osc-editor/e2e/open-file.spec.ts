import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 15610
const FORWARD_PORT = 15611
const BEACON_PORT = 15612

// Finder double-click of a .oscproj fires app 'open-file'; e2e emits the
// event directly (the native path can't be driven from a test).

function writeProject(dir: string): string {
  const path = join(dir, 'project.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      duration: 10,
      tracks: [],
      markers: [{ time: 1 }]
    })
  )
  return path
}

async function launchUntitled(
  workdir: string,
  env: Record<string, string> = {}
): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(__dirname, '../out/main/index.js')],
    cwd: workdir,
    env: {
      ...process.env,
      OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir,
      ...env
    }
  })
}

const emitOpenFile = (app: ElectronApplication, path: string): Promise<void> =>
  app.evaluate(({ app: a }, p) => {
    a.emit('open-file', { preventDefault: () => {} }, p)
  }, path)

test('open-file while running loads the project', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  const projectPath = writeProject(workdir)
  const app = await launchUntitled(workdir)
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await expect.poll(() => page.title()).toBe('VTR')

    await emitOpenFile(app, projectPath)
    await expect.poll(() => page.title()).toBe('VTR - project.json')
    await expect(page.locator('.marker-flag')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('open-file with unsaved changes: cancel keeps the current doc', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  const projectPath = writeProject(workdir)
  const app = await launchUntitled(workdir, { OSC_EDITOR_QUIT_CHOICE: 'cancel' })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    await page.getByRole('button', { name: 'add marker' }).click()
    await expect.poll(() => page.title()).toContain('(edited)')

    await emitOpenFile(app, projectPath)
    // The prompt was declined: still the untitled dirty doc.
    await page.waitForTimeout(300)
    await expect.poll(() => page.title()).toBe('VTR (edited)')
  } finally {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.destroy())
    })
    await app.close()
  }
})
