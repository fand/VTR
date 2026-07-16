# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.ts >> record → clip on track → drag → delete → persisted
- Location: e2e/app.spec.ts:55:5

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
  8   | const BEACON_PORT = 10012
  9   | 
  10  | function pad4(b: Buffer): Buffer {
  11  |   return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
  12  | }
  13  | 
  14  | /** Minimal OSC message encoder (float args only). */
  15  | function oscMessage(addr: string, floats: number[]): Buffer {
  16  |   const addrB = pad4(Buffer.from(addr + '\0'))
  17  |   const tagsB = pad4(Buffer.from(',' + 'f'.repeat(floats.length) + '\0'))
  18  |   const argsB = Buffer.alloc(4 * floats.length)
  19  |   floats.forEach((f, i) => argsB.writeFloatBE(f, i * 4))
  20  |   return Buffer.concat([addrB, tagsB, argsB])
  21  | }
  22  | 
  23  | function sleep(ms: number): Promise<void> {
  24  |   return new Promise((r) => setTimeout(r, ms))
  25  | }
  26  | 
  27  | interface Launched {
  28  |   app: ElectronApplication
  29  |   page: Page
  30  |   workdir: string
  31  | }
  32  | 
  33  | async function launchApp(): Promise<Launched> {
  34  |   const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  35  |   const app = await electron.launch({
  36  |     args: [join(__dirname, '../out/main/index.js')],
  37  |     cwd: workdir,
  38  |     env: {
  39  |       ...process.env,
  40  |       OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap')
  41  |     }
  42  |   })
  43  |   app.process().stdout?.on('data', (d) => console.log(`[main] ${d.toString().trimEnd()}`))
  44  |   app.process().stderr?.on('data', (d) => console.log(`[main!] ${d.toString().trimEnd()}`))
  45  |   const page = await app.firstWindow()
  46  |   page.on('console', (msg) => console.log(`[renderer] ${msg.text()}`))
> 47  |   await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
      |                                               ^ Error: expect(locator).toHaveText(expected) failed
  48  |   return { app, page, workdir }
  49  | }
  50  | 
  51  | function readProject(workdir: string): { tracks: { clips: Record<string, number>[] }[] } {
  52  |   return JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8'))
  53  | }
  54  | 
  55  | test('record → clip on track → drag → delete → persisted', async () => {
  56  |   const { app, page, workdir } = await launchApp()
  57  |   const sock = dgram.createSocket('udp4')
  58  |   try {
  59  |     await page.getByRole('button', { name: '● Rec' }).click()
  60  |     for (let i = 0; i < 15; i++) {
  61  |       sock.send(oscMessage('/fader', [i / 15]), LISTEN_PORT, '127.0.0.1')
  62  |       await sleep(150)
  63  |     }
  64  |     await page.getByRole('button', { name: '■ Stop' }).click()
  65  | 
  66  |     const clip = page.locator('.clip:not(.recording)')
  67  |     await expect(clip).toHaveCount(1)
  68  |     await expect(page.locator('.clip-meta')).toContainText('15 ev')
  69  | 
  70  |     await sleep(600) // autosave debounce
  71  |     const saved = readProject(workdir)
  72  |     expect(saved.tracks).toHaveLength(1)
  73  |     expect(saved.tracks[0].clips[0].offset).toBe(0)
  74  | 
  75  |     // Drag right by 100px = +5s at 20px/s.
  76  |     const box = (await clip.boundingBox())!
  77  |     await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  78  |     await page.mouse.down()
  79  |     await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 })
  80  |     await page.mouse.up()
  81  |     await sleep(600)
  82  |     const dragged = readProject(workdir)
  83  |     expect(dragged.tracks[0].clips[0].offset).toBeGreaterThan(4)
  84  |     expect(dragged.tracks[0].clips[0].offset).toBeLessThan(6)
  85  | 
  86  |     // Delete the selected clip.
  87  |     await clip.click()
  88  |     await page.keyboard.press('Delete')
  89  |     await expect(page.locator('.clip')).toHaveCount(0)
  90  |     await sleep(600)
  91  |     expect(readProject(workdir).tracks).toHaveLength(0)
  92  |   } finally {
  93  |     sock.close()
  94  |     await app.close()
  95  |   }
  96  | })
  97  | 
  98  | test('beacon → tl recorded → clip auto-aligned at record stop', async () => {
  99  |   const { app, page } = await launchApp()
  100 |   const sock = dgram.createSocket('udp4')
  101 |   // TD-style beacon at 10Hz, timeline running from 100s.
  102 |   const beaconStart = Date.now()
  103 |   const beacon = setInterval(() => {
  104 |     const tl = 100 + (Date.now() - beaconStart) / 1000
  105 |     sock.send(oscMessage('/clock', [tl, 1.0]), BEACON_PORT, '127.0.0.1')
  106 |   }, 100)
  107 |   try {
  108 |     await expect(page.locator('.chip', { hasText: 'clock tl=' })).toBeVisible({
  109 |       timeout: 5000
  110 |     })
  111 |     await page.getByRole('button', { name: '● Rec' }).click()
  112 |     for (let i = 0; i < 5; i++) {
  113 |       sock.send(oscMessage('/x', [i]), LISTEN_PORT, '127.0.0.1')
  114 |       await sleep(100)
  115 |     }
  116 |     await page.getByRole('button', { name: '■ Stop' }).click()
  117 | 
  118 |     const clip = page.locator('.clip:not(.recording)')
  119 |     await expect(clip).toHaveCount(1)
  120 |     // offset = median(tl - t) ≈ 100s → placed at ~100s * 20px/s ≈ 2000px.
  121 |     const left = await clip.evaluate((el) => parseFloat((el as HTMLElement).style.left))
  122 |     expect(left).toBeGreaterThan(1900)
  123 |     expect(left).toBeLessThan(2300)
  124 |   } finally {
  125 |     clearInterval(beacon)
  126 |     sock.close()
  127 |     await app.close()
  128 |   }
  129 | })
  130 | 
```