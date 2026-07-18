import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'
import dgram from 'node:dgram'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Suite-specific ports so a running dev instance never collides.
const LISTEN_PORT = 15410
const TD_PORT = 15411
const BEACON_PORT = 15412

function pad4(b: Buffer): Buffer {
  return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
}

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

async function launch(
  workdir: string,
  projectArg: string,
  dialogPath: string
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js'), projectArg],
    cwd: workdir,
    env: {
      ...process.env,
      OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap'),
      OSC_EDITOR_HIDDEN: '1',
      OSC_EDITOR_DATA_DIR: workdir,
      OSC_EDITOR_DIALOG_PATH: dialogPath
    }
  })
  const page = await app.firstWindow()
  await expect(page.locator('.stat', { hasText: 'tap:' })).toHaveText(/on/, { timeout: 15_000 })
  return { app, page }
}

async function recordClip(page: Page, sock: dgram.Socket, n: number, clips: number): Promise<void> {
  await page.getByRole('button', { name: 'Rec' }).click()
  for (let i = 0; i < n; i++) {
    sock.send(oscMessage('/fader', [i / n]), LISTEN_PORT, '127.0.0.1')
    await sleep(100)
  }
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.clip:not(.recording)')).toHaveCount(clips)
}

function clipFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith('clip-') && f.endsWith('.jsonl'))
    : []
}

test('bundle: rec into project clips/, Save As collects into .oscproj, reopen + export', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  const bundle = join(workdir, 'my.oscproj')
  writeFileSync(
    join(workdir, 'project.json'),
    JSON.stringify({
      version: 1,
      ports: { listen: LISTEN_PORT, forward: TD_PORT, beacon: BEACON_PORT },
      tracks: []
    })
  )
  const sock = dgram.createSocket('udp4')

  const { app, page } = await launch(workdir, join(workdir, 'project.json'), bundle)
  try {
    // A loaded project records straight into its clips/, not the cwd or staging.
    await recordClip(page, sock, 5, 1)
    expect(clipFiles(join(workdir, 'clips'))).toHaveLength(1)
    expect(clipFiles(workdir)).toHaveLength(0)
    expect(clipFiles(join(workdir, 'recordings'))).toHaveLength(0)

    // Save As -> the dialog (env stand-in) picks my.oscproj.
    await page.keyboard.press('ControlOrMeta+Shift+s')
    await expect.poll(() => page.title()).toBe('VTR - my.oscproj')
    if (process.platform === 'darwin') {
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].getRepresentedFilename()
          )
        )
        .toBe(bundle)
    }
    const saved = JSON.parse(readFileSync(join(bundle, 'project.json'), 'utf8'))
    expect(saved.tracks[0].clips).toHaveLength(1)
    const file = saved.tracks[0].clips[0].file as string
    expect(file).not.toContain('/')
    // Collected as a copy: the old project keeps its clip.
    expect(existsSync(join(bundle, 'clips', file))).toBe(true)
    expect(existsSync(join(workdir, 'clips', file))).toBe(true)
  } finally {
    await app.close()
  }

  // Reopen the bundle by its dir path; content plays and records into it.
  const { app: app2, page: page2 } = await launch(workdir, bundle, bundle)
  try {
    await expect(page2.locator('.clip')).toHaveCount(1)
    await recordClip(page2, sock, 3, 2)
    expect(clipFiles(join(bundle, 'clips'))).toHaveLength(2)

    // Export defaults next to the bundle, not inside it.
    await page2.getByRole('button', { name: 'File' }).click()
    await page2.getByRole('button', { name: 'Export' }).click()
    await expect(page2.locator('.info-banner')).toContainText('exported')
    const lines = readFileSync(join(workdir, 'session.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(lines[0].type).toBe('session_start')
    // 5 + 3 recorded events between the session markers.
    expect(lines.length).toBe(10)
  } finally {
    sock.close()
    await app2.close()
  }
})

test('bundle: untitled record → Save As moves staged clips into the bundle', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'vtr-e2e-'))
  const bundle = join(workdir, 'live.oscproj')
  // No CLI project arg: the session is untitled, recordings stage in userData.
  const { app, page } = await launch(workdir, '', bundle)
  const sock = dgram.createSocket('udp4')
  let staged: string[] = []
  try {
    await recordClip(page, sock, 5, 1)
    staged = clipFiles(join(workdir, 'recordings'))
    expect(staged).toHaveLength(1)

    // Save As (dialog env supplies the bundle path): the staged clip moves
    // into the bundle — copied first, source deleted only after commit.
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => existsSync(join(bundle, 'project.json'))).toBe(true)
    expect(clipFiles(join(bundle, 'clips'))).toEqual(staged)
    await expect.poll(() => clipFiles(join(workdir, 'recordings'))).toEqual([])
  } finally {
    sock.close()
    await app.close()
  }

  // Relaunch on the bundle: the clip resolves.
  const { app: app2, page: page2 } = await launch(workdir, bundle, bundle)
  try {
    await expect(page2.locator('.clip')).toHaveCount(1)
    await expect(page2.locator('.clip.missing')).toHaveCount(0)
  } finally {
    await app2.close()
  }
})
