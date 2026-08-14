import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'
import dgram from 'node:dgram'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance (default 10010-10012) never collides.
const LISTEN_PORT = 16210
const FORWARD_PORT = 16211

function pad4(b: Buffer): Buffer {
  return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
}

/** Minimal OSC message encoder (float args only). */
function oscMessage(addr: string, floats: number[]): Buffer {
  const addrB = pad4(Buffer.from(addr + '\0'))
  const tagsB = pad4(Buffer.from(',' + 'f'.repeat(floats.length) + '\0'))
  const argsB = Buffer.alloc(4 * floats.length)
  floats.forEach((f, i) => argsB.writeFloatBE(f, i * 4))
  return Buffer.concat([addrB, tagsB, argsB])
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: FORWARD_PORT },
      tracks: []
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
  const page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  return { app, page }
}

test('OSC monitor logs live traffic without recording', async () => {
  const { app, page } = await launchApp()
  const sock = dgram.createSocket('udp4')
  try {
    // The monitor poll loop must be up before the first packet counts.
    await sleep(500)
    for (let i = 0; i < 5; i++) {
      sock.send(oscMessage('/fader', [i / 10]), LISTEN_PORT, '127.0.0.1')
      await sleep(50)
    }
    const lines = page.locator('.osc-monitor-line')
    await expect(lines.last()).toContainText('/fader', { timeout: 5000 })
    // Timestamp prefix + address + arg.
    await expect(lines.last()).toContainText(/\d{2}:\d{2}:\d{2}\.\d{3} \/fader 0\.\d+/)

    // Clear empties the log; new traffic starts it again.
    await page.getByRole('button', { name: 'clear log' }).click()
    await expect(lines).toHaveCount(0)
    sock.send(oscMessage('/knob', [0.5]), LISTEN_PORT, '127.0.0.1')
    await expect(lines.last()).toContainText('/knob', { timeout: 5000 })

    // Follow is on by default; turning it off is sticky UI state.
    const follow = page.getByRole('checkbox', { name: 'auto-scroll' })
    await expect(follow).toBeChecked()
    await follow.uncheck()
    await expect(follow).not.toBeChecked()
  } finally {
    sock.close()
    await app.close()
  }
})
