import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Touches the user's launchd domain — run explicitly:
//   RUN_LAUNCHD=1 npx playwright test e2e/launchd.spec.ts
test.skip(
  process.platform !== 'darwin' || !process.env.RUN_LAUNCHD,
  'launchd test only on demand (RUN_LAUNCHD=1)'
)

const LABEL = 'com.fand.vtr.osc-tap'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function tapPid(): number | null {
  try {
    const out = execFileSync('pgrep', ['-f', 'osc-tap --listen'], { encoding: 'utf8' })
    const pid = parseInt(out.trim().split('\n')[0], 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

function jobLoaded(): boolean {
  try {
    execFileSync('launchctl', ['print', `gui/${process.getuid!()}/${LABEL}`], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

test('launchd agent: crash restart + bootout on quit', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-launchd-'))
  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js')],
    cwd: workdir,
    env: {
      ...process.env,
      OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir,
      OSC_TAP_SPAWN: 'launchd'
    }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
    expect(jobLoaded()).toBe(true)
    const pid1 = tapPid()
    expect(pid1).not.toBeNull()

    // Crash the tap; launchd must restart it.
    execFileSync('kill', ['-9', String(pid1)])
    let pid2: number | null = null
    for (let i = 0; i < 30; i++) {
      await sleep(500)
      pid2 = tapPid()
      if (pid2 !== null && pid2 !== pid1) break
    }
    expect(pid2).not.toBeNull()
    expect(pid2).not.toBe(pid1)
    // Editor reconnects through its control socket.
    await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  } finally {
    await app.close()
  }

  // Clean editor exit must bootout the agent AND remove the plist —
  // RunAtLoad=true would otherwise re-bootstrap the tap at next login.
  await sleep(1500)
  expect(jobLoaded()).toBe(false)
  expect(tapPid()).toBeNull()
  expect(existsSync(join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`))).toBe(false)
})
