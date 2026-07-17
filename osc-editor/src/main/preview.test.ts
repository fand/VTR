import type dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import { Preview } from './preview'

class FakeSock extends EventEmitter {
  sent: Buffer[] = []
  sendErr: Error | null = null
  send(buf: Buffer, _port: number, _host: string, cb?: (err: Error | null) => void): void {
    this.sent.push(buf)
    cb?.(this.sendErr)
  }
}

const asSock = (s: FakeSock): dgram.Socket => s as unknown as dgram.Socket

const EV = { t: 0, port: 1, a: '/x', args: [1] }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

test("socket 'error' stops playback and notifies instead of crashing", async () => {
  const sock = new FakeSock()
  const errors: string[] = []
  const p = new Preview(asSock(sock), (m) => errors.push(m))
  p.play([{ ...EV, t: 10 }], 0, 9999)
  expect(p.playing).toBe(true)
  // Without a listener this emit would throw (unhandled 'error').
  sock.emit('error', new Error('boom'))
  expect(p.playing).toBe(false)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/boom/)
  await sleep(5)
})

test('async send failures are counted and reported once', async () => {
  const sock = new FakeSock()
  const errors: string[] = []
  const p = new Preview(asSock(sock), (m) => errors.push(m))
  sock.sendErr = new Error('refused')
  p.play(
    [EV, { ...EV, t: 0.001 }],
    0,
    9999
  )
  await sleep(20)
  expect(sock.sent.length).toBe(2)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/refused/)
  // A new play() reports again.
  p.play([EV], 0, 9999)
  await sleep(10)
  expect(errors).toHaveLength(2)
})
