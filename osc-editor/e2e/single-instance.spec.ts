import { _electron as electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 15710
const FORWARD_PORT = 15711
const BEACON_PORT = 15712

// The lock is scoped to userData (OSC_EDITOR_DATA_DIR), so every other e2e
// suite — each with its own workdir — is unaffected.

test('second instance forwards its project arg to the first and quits', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  const projectPath = join(projectDir, 'project.json')
  writeFileSync(
    projectPath,
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT, beacon: BEACON_PORT },
      duration: 10,
      tracks: []
    })
  )

  const env = {
    ...process.env,
    OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
    OSC_EDITOR_HIDDEN: '1',
    OSC_EDITOR_DATA_DIR: workdir
  }
  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js')],
    cwd: workdir,
    env
  })
  app.process().stdout?.on('data', (d) => console.log(`[main] ${d.toString().trimEnd()}`))
  app.process().stderr?.on('data', (d) => console.log(`[main!] ${d.toString().trimEnd()}`))
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
    await expect.poll(() => page.title()).toBe('VTR')

    // Second launch on the same userData: must exit, first must load the arg.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronBin = require('electron') as unknown as string
    const exitCode = await new Promise<number | null>((resolvePromise) => {
      const child = execFile(
        electronBin,
        [join(__dirname, '../out/main/index.js'), projectPath],
        { cwd: workdir, env },
        () => {}
      )
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolvePromise(code)
      })
    })
    expect(exitCode).toBe(0)
    await expect.poll(() => page.title()).toBe('VTR - project.json')
  } finally {
    await app.close()
  }
})
