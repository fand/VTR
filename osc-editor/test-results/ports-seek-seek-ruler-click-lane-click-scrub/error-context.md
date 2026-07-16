# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ports-seek.spec.ts >> seek: ruler click, lane click, scrub
- Location: e2e/ports-seek.spec.ts:42:5

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
  7   | function pad4(b: Buffer): Buffer {
  8   |   return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
  9   | }
  10  | 
  11  | function oscMessage(addr: string, floats: number[]): Buffer {
  12  |   const addrB = pad4(Buffer.from(addr + '\0'))
  13  |   const tagsB = pad4(Buffer.from(',' + 'f'.repeat(floats.length) + '\0'))
  14  |   const argsB = Buffer.alloc(4 * floats.length)
  15  |   floats.forEach((f, i) => argsB.writeFloatBE(f, i * 4))
  16  |   return Buffer.concat([addrB, tagsB, argsB])
  17  | }
  18  | 
  19  | function sleep(ms: number): Promise<void> {
  20  |   return new Promise((r) => setTimeout(r, ms))
  21  | }
  22  | 
  23  | async function launchApp(): Promise<{ app: ElectronApplication; page: Page; workdir: string }> {
  24  |   const workdir = mkdtempSync(join(tmpdir(), 'osc-mtr-e2e-'))
  25  |   const app = await electron.launch({
  26  |     args: [join(__dirname, '../out/main/index.js')],
  27  |     cwd: workdir,
  28  |     env: {
  29  |       ...process.env,
  30  |       OSC_TAP_BIN: join(__dirname, '../../osc-tap/target/debug/osc-tap')
  31  |     }
  32  |   })
  33  |   const page = await app.firstWindow()
> 34  |   await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
      |                                               ^ Error: expect(locator).toHaveText(expected) failed
  35  |   return { app, page, workdir }
  36  | }
  37  | 
  38  | async function playheadLeft(page: Page): Promise<number> {
  39  |   return page.locator('.playhead').evaluate((el) => parseFloat((el as HTMLElement).style.left))
  40  | }
  41  | 
  42  | test('seek: ruler click, lane click, scrub', async () => {
  43  |   const { app, page } = await launchApp()
  44  |   const sock = dgram.createSocket('udp4')
  45  |   try {
  46  |     // Need one clip so there is a track lane to click.
  47  |     await page.getByRole('button', { name: '● Rec' }).click()
  48  |     for (let i = 0; i < 5; i++) {
  49  |       sock.send(oscMessage('/x', [i]), 10010, '127.0.0.1')
  50  |       await sleep(100)
  51  |     }
  52  |     await page.getByRole('button', { name: '■ Stop' }).click()
  53  |     await expect(page.locator('.clip:not(.recording)')).toHaveCount(1)
  54  | 
  55  |     // Ruler click at x=200 → playhead at 96 + 200.
  56  |     await page.locator('.ruler').click({ position: { x: 200, y: 10 } })
  57  |     expect(await playheadLeft(page)).toBeCloseTo(296, 0)
  58  |     await expect(page.locator('.timecode')).toHaveText('00:00:10.000')
  59  | 
  60  |     // Empty lane click at x=300.
  61  |     await page.locator('.track-lane').first().click({ position: { x: 300, y: 55 } })
  62  |     expect(await playheadLeft(page)).toBeCloseTo(396, 0)
  63  | 
  64  |     // Scrub: drag along the ruler.
  65  |     const ruler = page.locator('.ruler')
  66  |     const box = (await ruler.boundingBox())!
  67  |     await page.mouse.move(box.x + 100, box.y + 10)
  68  |     await page.mouse.down()
  69  |     await page.mouse.move(box.x + 150, box.y + 10, { steps: 5 })
  70  |     await page.mouse.up()
  71  |     expect(await playheadLeft(page)).toBeCloseTo(246, 0)
  72  |   } finally {
  73  |     sock.close()
  74  |     await app.close()
  75  |   }
  76  | })
  77  | 
  78  | test('ports editable in header; tap restarts on new ports', async () => {
  79  |   const { app, page, workdir } = await launchApp()
  80  |   const sock = dgram.createSocket('udp4')
  81  |   const td = dgram.createSocket('udp4')
  82  |   const forwarded: Buffer[] = []
  83  |   td.on('message', (m) => forwarded.push(m))
  84  |   await new Promise<void>((r) => td.bind(11011, '127.0.0.1', r))
  85  |   try {
  86  |     await page.getByLabel('in port').fill('11010')
  87  |     await page.getByLabel('in port').press('Enter')
  88  |     await page.getByLabel('out port').fill('11011')
  89  |     await page.getByLabel('out port').press('Enter')
  90  | 
  91  |     // tap restarts (child respawn ~1s); wait until it records on the new port.
  92  |     await sleep(2500)
  93  |     await expect(page.locator('.chip').first()).toHaveText('tap up', { timeout: 15_000 })
  94  | 
  95  |     await page.getByRole('button', { name: '● Rec' }).click()
  96  |     for (let i = 0; i < 5; i++) {
  97  |       sock.send(oscMessage('/y', [i]), 11010, '127.0.0.1')
  98  |       await sleep(100)
  99  |     }
  100 |     await page.getByRole('button', { name: '■ Stop' }).click()
  101 |     await expect(page.locator('.clip:not(.recording)')).toHaveCount(1)
  102 |     await expect(page.locator('.clip-meta').first()).toContainText('5 ev')
  103 |     expect(forwarded.length).toBe(5)
  104 | 
  105 |     // Persisted to project.json.
  106 |     await sleep(600)
  107 |     const project = JSON.parse(readFileSync(join(workdir, 'project.json'), 'utf8'))
  108 |     expect(project.ports).toEqual({ listen: 11010, forward: 11011 })
  109 |   } finally {
  110 |     td.close()
  111 |     sock.close()
  112 |     await app.close()
  113 |   }
  114 | })
  115 | 
```