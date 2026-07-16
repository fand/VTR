# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: export-preview.spec.ts >> preview replays events to TD port with original spacing
- Location: e2e/export-preview.spec.ts:78:5

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  locator('.chip').first()
Expected: "tap up"
Received: "tap down"
Timeout:  15000ms

Call log:
  - Expect "toHaveText" with timeout 15000ms
  - waiting for locator('.chip').first()
    14 × locator resolved to <span class="chip">tap …</span>
       - unexpected value "tap …"
    20 × locator resolved to <span class="chip bad">tap down</span>
       - unexpected value "tap down"

```

```yaml
- text: tap down
```

# Test source

```ts
  1   | import { _electron as electron, ElectronApplication, Page, expect, test } from '@playwright/test'
  2   | import dgram from 'node:dgram'
  3   | import { mkdtempSync, readFileSync } from 'node:fs'
  4   | import { tmpdir } from 'node:os'
  5   | import { join } from 'node:path'
  6   | 
  7   | const LISTEN_PORT = 10010
  8   | const TD_PORT = 10011
  9   | 
  10  | function pad4(b: Buffer): Buffer {
  11  |   return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
  12  | }
  13  | 
  14  | function oscMessage(addr: string, floats: number[]): Buffer {
  15  |   const addrB = pad4(Buffer.from(addr + '\0'))
  16  |   const tagsB = pad4(Buffer.from(',' + 'f'.repeat(floats.length) + '\0'))
  17  |   const argsB = Buffer.alloc(4 * floats.length)
  18  |   floats.forEach((f, i) => argsB.writeFloatBE(f, i * 4))
  19  |   return Buffer.concat([addrB, tagsB, argsB])
  20  | }
  21  | 
  22  | function sleep(ms: number): Promise<void> {
  23  |   return new Promise((r) => setTimeout(r, ms))
  24  | }
  25  | 
  26  | async function launchApp(): Promise<{ app: ElectronApplication; page: Page; workdir: string }> {
  27  |   const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  28  |   const app = await electron.launch({
  29  |     args: [join(__dirname, '../out/main/index.js')],
  30  |     cwd: workdir,
  31  |     env: {
  32  |       ...process.env,
  33  |       OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap')
  34  |     }
  35  |   })
  36  |   const page = await app.firstWindow()
> 37  |   await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
      |                                               ^ Error: expect(locator).toHaveText(expected) failed
  38  |   return { app, page, workdir }
  39  | }
  40  | 
  41  | async function recordClip(page: Page, sock: dgram.Socket, n: number): Promise<void> {
  42  |   await page.getByRole('button', { name: '● Rec' }).click()
  43  |   for (let i = 0; i < n; i++) {
  44  |     sock.send(oscMessage('/fader', [i / n]), LISTEN_PORT, '127.0.0.1')
  45  |     await sleep(100)
  46  |   }
  47  |   await page.getByRole('button', { name: '■ Stop' }).click()
  48  |   await expect(page.locator('.clip:not(.recording)')).toHaveCount(1)
  49  | }
  50  | 
  51  | test('export writes merged session.jsonl', async () => {
  52  |   const { app, page, workdir } = await launchApp()
  53  |   const sock = dgram.createSocket('udp4')
  54  |   try {
  55  |     await recordClip(page, sock, 10)
  56  |     await page.getByRole('button', { name: 'Export' }).click()
  57  |     await expect(page.locator('.info-banner')).toContainText('exported')
  58  | 
  59  |     const lines = readFileSync(join(workdir, 'session.jsonl'), 'utf8')
  60  |       .split('\n')
  61  |       .filter(Boolean)
  62  |       .map((l) => JSON.parse(l))
  63  |     expect(lines[0].type).toBe('session_start')
  64  |     expect(lines[lines.length - 1].type).toBe('session_end')
  65  |     const events = lines.slice(1, -1)
  66  |     expect(events).toHaveLength(10)
  67  |     expect(events[0].a).toBe('/fader')
  68  |     expect(events[0].t).toBeGreaterThanOrEqual(0)
  69  |     const ts = events.map((e: { t: number }) => e.t)
  70  |     expect([...ts].sort((a, b) => a - b)).toEqual(ts)
  71  |     expect(lines[lines.length - 1].t).toBeGreaterThanOrEqual(ts[ts.length - 1])
  72  |   } finally {
  73  |     sock.close()
  74  |     await app.close()
  75  |   }
  76  | })
  77  | 
  78  | test('preview replays events to TD port with original spacing', async () => {
  79  |   const { app, page } = await launchApp()
  80  |   const sock = dgram.createSocket('udp4')
  81  |   // Stand-in TD: collect datagrams with arrival times.
  82  |   const td = dgram.createSocket('udp4')
  83  |   const received: { at: number; addr: string }[] = []
  84  |   let collecting = false
  85  |   td.on('message', (msg) => {
  86  |     if (collecting) received.push({ at: Date.now(), addr: msg.toString('ascii', 0, 6) })
  87  |   })
  88  |   await new Promise<void>((r) => td.bind(TD_PORT, '127.0.0.1', r))
  89  |   try {
  90  |     await recordClip(page, sock, 10) // ~0.9s span
  91  |     collecting = true
  92  |     await page.getByRole('button', { name: '▶ Play' }).click()
  93  |     await sleep(2500) // playback (~0.9s) + margin
  94  |     expect(received.length).toBe(10)
  95  |     const span = received[received.length - 1].at - received[0].at
  96  |     expect(span).toBeGreaterThan(700)
  97  |     expect(span).toBeLessThan(1400)
  98  |     expect(received[0].addr).toContain('/fader')
  99  |     // Auto-stopped at the end.
  100 |     await expect(page.getByRole('button', { name: '▶ Play' })).toBeVisible()
  101 |   } finally {
  102 |     td.close()
  103 |     sock.close()
  104 |     await app.close()
  105 |   }
  106 | })
  107 | 
```