import { expect, test } from 'vitest'
import { applyEditsIndexed, editsEmpty } from './edits'
import type { OscEvent } from './types'

const ev = (t: number, args: unknown[] = [0]): OscEvent => ({ t, port: 1, a: '/x', args })

test('editsEmpty: absent, empty containers, and each non-empty kind', () => {
  expect(editsEmpty(undefined)).toBe(true)
  expect(editsEmpty({})).toBe(true)
  expect(editsEmpty({ set: {}, del: {}, add: [], curves: [] })).toBe(true)
  expect(editsEmpty({ set: { 0: { t: 1 } } })).toBe(false)
  expect(editsEmpty({ del: { 0: true } })).toBe(false)
  expect(editsEmpty({ add: [ev(0)] })).toBe(false)
  // Curves alone keep the sidecar alive (they ride the same overlay).
  expect(
    editsEmpty({
      curves: [
        {
          port: 1,
          a: '/x',
          arg: 0,
          args: [0],
          knots: [
            { t: 0, v: 0 },
            { t: 1, v: 1 }
          ]
        }
      ]
    })
  ).toBe(false)
})

test('set/del reach added events via keys past the original count', () => {
  const events = [ev(0), ev(1)]
  const out = applyEditsIndexed(events, {
    add: [ev(2, [5]), ev(3, [6])],
    // Index 2 = first added event; move it and patch its arg.
    set: { 2: { t: 9, args: { 0: 50 } } },
    // Index 3 = second added event; delete it.
    del: { 3: true }
  })
  expect(out.map((x) => x.idx)).toEqual([0, 1, 2])
  const moved = out.find((x) => x.idx === 2)!
  expect(moved.ev.t).toBe(9)
  expect(moved.ev.args).toEqual([50])
})

test('a t edit re-sorts events by time', () => {
  const out = applyEditsIndexed([ev(0), ev(1)], { set: { 0: { t: 5 } } })
  expect(out.map((x) => x.idx)).toEqual([1, 0])
})
