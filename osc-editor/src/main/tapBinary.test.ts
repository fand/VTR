import { expect, test } from 'vitest'
import { join } from 'path'
import { findTapBinary, type TapBinaryEnv } from './tapBinary'

const env = (over: Partial<TapBinaryEnv> = {}): TapBinaryEnv => ({
  isPackaged: false,
  resourcesPath: '/App.app/Contents/Resources',
  appPath: '/repo/osc-editor',
  ...over
})

const fakeFs = (
  files: Record<string, number>
): { existsSync: (p: string) => boolean; statSync: (p: string) => { mtimeMs: number } } => ({
  existsSync: (p: string) => p in files,
  statSync: (p: string) => ({ mtimeMs: files[p] })
})

const bundled = '/App.app/Contents/Resources/bin/osc-tap'
const release = join('/repo/osc-editor', '../osc-tap/target/release/osc-tap')
const debug = join('/repo/osc-editor', '../osc-tap/target/debug/osc-tap')

test('packaged: bundled binary wins over dev builds', () => {
  const fs = fakeFs({ [bundled]: 1, [release]: 999 })
  expect(findTapBinary(env({ isPackaged: true }), fs)).toBe(bundled)
})

test('packaged: falls back to dev builds when bundle is missing', () => {
  const fs = fakeFs({ [release]: 1 })
  expect(findTapBinary(env({ isPackaged: true }), fs)).toBe(release)
})

test('dev: most recently built of release/debug wins', () => {
  expect(findTapBinary(env(), fakeFs({ [release]: 1, [debug]: 2 }))).toBe(debug)
  expect(findTapBinary(env(), fakeFs({ [release]: 3, [debug]: 2 }))).toBe(release)
})

test('dev: never picks the packaged path', () => {
  const fs = fakeFs({ [bundled]: 1 })
  expect(() => findTapBinary(env(), fs)).toThrow(/not found/)
})

test('OSC_TAP_BIN overrides everything, must exist', () => {
  const fs = fakeFs({ '/custom/tap': 1, [bundled]: 2, [release]: 3 })
  expect(findTapBinary(env({ isPackaged: true, envBin: '/custom/tap' }), fs)).toBe('/custom/tap')
  expect(() => findTapBinary(env({ envBin: '/gone' }), fs)).toThrow(/OSC_TAP_BIN not found/)
})
