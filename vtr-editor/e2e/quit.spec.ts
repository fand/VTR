import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 15510
const FORWARD_PORT = 15511

// Closing a dirty window prompts save/discard/cancel. Hidden (e2e) mode
// takes the choice from OSC_EDITOR_QUIT_CHOICE (default: discard).

async function launchDirty(
  quitChoice?: string
): Promise<{ app: ElectronApplication; workdir: string }> {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      duration: 10,
      tracks: []
    })
  )
  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js'), join(workdir, 'project.json')],
    cwd: workdir,
    env: {
      ...process.env,
      VTR_TAP_BIN: join(__dirname, '../../vtr-tap/target/debug/vtr-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir,
      ...(quitChoice ? { OSC_EDITOR_QUIT_CHOICE: quitChoice } : {})
    }
  })
  const page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  // Dirty the doc with a marker; wait for the dirty state to reach main.
  await page.getByRole('button', { name: 'add marker' }).click()
  await expect.poll(() => page.title()).toContain('(edited)')
  return { app, workdir }
}

const closeWindow = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close()
  })

const readMarkers = (workdir: string): unknown[] =>
  JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8')).markers ?? []

test('quit prompt: cancel keeps the app open and saves nothing', async () => {
  const { app, workdir } = await launchDirty('cancel')
  try {
    await closeWindow(app)
    // Still running: the window answers and the edit is still unsaved.
    const page = await app.firstWindow()
    await expect.poll(() => page.title()).toContain('(edited)')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(readMarkers(workdir)).toHaveLength(0)
  } finally {
    // The guard cancels every close while dirty; destroy to let the app exit.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.destroy())
    })
    await app.close()
  }
})

test('quit prompt: save writes the project, then quits', async () => {
  const { app, workdir } = await launchDirty('save')
  const closed = new Promise<void>((resolve) => app.on('close', resolve))
  await closeWindow(app)
  await closed
  expect(readMarkers(workdir)).toHaveLength(1)
})

test('quit prompt default (discard): quits without saving', async () => {
  const { app, workdir } = await launchDirty()
  const closed = new Promise<void>((resolve) => app.on('close', resolve))
  await closeWindow(app)
  await closed
  expect(readMarkers(workdir)).toHaveLength(0)
})
