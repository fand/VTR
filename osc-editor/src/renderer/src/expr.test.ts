import { expect, test } from 'vitest'
import { MAX_DURATION_S, evalExpr, parseDuration } from './expr'

test('evalExpr arithmetic', () => {
  expect(evalExpr('60*2')).toBe(120)
  expect(evalExpr('(1+2)*3')).toBe(9)
  expect(evalExpr('60*')).toBeNull()
  expect(evalExpr('1/0')).toBeNull()
})

test('parseDuration accepts arithmetic, rejects non-positive', () => {
  expect(parseDuration('60*2')).toBe(120)
  expect(parseDuration('0')).toBeNull()
  expect(parseDuration('-5')).toBeNull()
  expect(parseDuration('abc')).toBeNull()
})

test('parseDuration clamps huge values to the max', () => {
  expect(parseDuration('99999999')).toBe(MAX_DURATION_S)
  expect(parseDuration('86400')).toBe(MAX_DURATION_S)
  expect(parseDuration('86399')).toBe(86399)
  expect(parseDuration('99999999*99999999')).toBe(MAX_DURATION_S)
})
