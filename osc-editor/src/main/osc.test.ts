import { expect, test } from 'vitest'
import { encodeOscMessage } from './osc'

/** Split an encoded message into its tag string and payload buffer. */
function parts(buf: Buffer): { tags: string; payload: Buffer } {
  const addrEnd = buf.indexOf(0)
  const tagStart = addrEnd + ((4 - (addrEnd + 1) % 4) % 4) + 1
  const tagEnd = buf.indexOf(0, tagStart)
  const tags = buf.toString('ascii', tagStart, tagEnd)
  const payloadStart = tagEnd + ((4 - (tagEnd + 1) % 4) % 4) + 1
  return { tags, payload: buf.subarray(payloadStart) }
}

test('no types: guessing as before (integral number → i)', () => {
  const { tags, payload } = parts(encodeOscMessage('/x', [2]))
  expect(tags).toBe(',i')
  expect(payload.readInt32BE(0)).toBe(2)
})

test('tag f keeps an integral float a float', () => {
  const { tags, payload } = parts(encodeOscMessage('/x', [2], 'f'))
  expect(tags).toBe(',f')
  expect(payload.readFloatBE(0)).toBe(2)
})

test('tag d keeps double precision', () => {
  const { tags, payload } = parts(encodeOscMessage('/x', [0.1], 'd'))
  expect(tags).toBe(',d')
  expect(payload.readDoubleBE(0)).toBe(0.1)
})

test('tag h reads a string-recorded int64 exactly', () => {
  const big = '9007199254740993' // 2^53 + 1
  const { tags, payload } = parts(encodeOscMessage('/x', [big], 'h'))
  expect(tags).toBe(',h')
  expect(payload.readBigInt64BE(0)).toBe(9007199254740993n)
})

test('tag h accepts a small number-recorded int64', () => {
  const { tags, payload } = parts(encodeOscMessage('/x', [3], 'h'))
  expect(tags).toBe(',h')
  expect(payload.readBigInt64BE(0)).toBe(3n)
})

test('tag s protects strings that look like impulse/color', () => {
  const { tags, payload } = parts(encodeOscMessage('/x', ['<impulse>', '#ff001020'], 'ss'))
  expect(tags).toBe(',ss')
  expect(payload.toString('ascii', 0, 9)).toBe('<impulse>')
})

test('tag i rounds a curve-edited fraction, stays int', () => {
  const { tags, payload } = parts(encodeOscMessage('/x', [2.4], 'i'))
  expect(tags).toBe(',i')
  expect(payload.readInt32BE(0)).toBe(2)
})

test('value/tag mismatch falls back to guessing per arg', () => {
  // 'h' with a non-numeric string can't encode; guess makes it 's'.
  const { tags } = parts(encodeOscMessage('/x', ['abc', 0.5], 'hf'))
  expect(tags).toBe(',sf')
})

test('length mismatch ignores types entirely', () => {
  const { tags } = parts(encodeOscMessage('/x', [2], 'ff'))
  expect(tags).toBe(',i')
})

test('T/F/I/N/r tags reproduce via guessing', () => {
  const { tags } = parts(
    encodeOscMessage('/x', [true, false, '<impulse>', null, '#ff001020'], 'TFINr')
  )
  expect(tags).toBe(',TFINr')
})
