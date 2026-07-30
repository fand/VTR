import { expect, test } from 'vitest'
import { DEFAULT_PORTS, isValidEchoHost, normalizePorts } from './types'

test('normalizePorts back-fills and drops legacy keys', () => {
  expect(normalizePorts()).toEqual(DEFAULT_PORTS)
  // Pre-echoHost project files get the auto default, not undefined.
  expect(normalizePorts({ listen: 1, forward: 2, echo: 3 })).toEqual({
    listen: 1,
    forward: 2,
    echo: 3,
    echoHost: ''
  })
  expect(normalizePorts({ beacon: 10012 } as never).echoHost).toBe('')
})

test('normalizePorts falls back to auto on a garbage echo host', () => {
  expect(normalizePorts({ echoHost: '10.0.1.5' }).echoHost).toBe('10.0.1.5')
  expect(normalizePorts({ echoHost: 'not-an-ip' }).echoHost).toBe('')
})

test('isValidEchoHost takes IP literals and empty, not hostnames', () => {
  expect(isValidEchoHost('')).toBe(true)
  expect(isValidEchoHost('127.0.0.1')).toBe(true)
  expect(isValidEchoHost('10.0.1.5')).toBe(true)
  expect(isValidEchoHost('::1')).toBe(true)
  expect(isValidEchoHost('fe80::1')).toBe(true)
  // The player parses an IpAddr, so a name it cannot resolve is rejected here.
  expect(isValidEchoHost('ipad.local')).toBe(false)
  expect(isValidEchoHost('10.0.1.999')).toBe(false)
  expect(isValidEchoHost('10.0.1')).toBe(false)
  // host:port belongs in the two fields, not one.
  expect(isValidEchoHost('10.0.1.5:9000')).toBe(false)
})
