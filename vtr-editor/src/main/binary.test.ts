import { expect, test } from 'vitest'
import { join } from 'path'
import { findBinary, type BinaryEnv } from './binary'

const env = (over: Partial<BinaryEnv> = {}): BinaryEnv => ({
  isPackaged: false,
  resourcesPath: '/App.app/Contents/Resources',
  appPath: '/repo/vtr-editor',
  ...over
})

const fakeFs = (
  files: Record<string, number>
): { existsSync: (p: string) => boolean; statSync: (p: string) => { mtimeMs: number } } => ({
  existsSync: (p: string) => p in files,
  statSync: (p: string) => ({ mtimeMs: files[p] })
})

const bundled = '/App.app/Contents/Resources/bin/vtr-tap'
const release = join('/repo/vtr-editor', '../target/release/vtr-tap')
const debug = join('/repo/vtr-editor', '../target/debug/vtr-tap')

test('packaged: bundled binary wins over dev builds', () => {
  const fs = fakeFs({ [bundled]: 1, [release]: 999 })
  expect(findBinary('vtr-tap', env({ isPackaged: true }), fs)).toBe(bundled)
})

test('packaged: falls back to dev builds when bundle is missing', () => {
  const fs = fakeFs({ [release]: 1 })
  expect(findBinary('vtr-tap', env({ isPackaged: true }), fs)).toBe(release)
})

test('dev: most recently built of release/debug wins', () => {
  expect(findBinary('vtr-tap', env(), fakeFs({ [release]: 1, [debug]: 2 }))).toBe(debug)
  expect(findBinary('vtr-tap', env(), fakeFs({ [release]: 3, [debug]: 2 }))).toBe(release)
})

test('dev: never picks the packaged path', () => {
  const fs = fakeFs({ [bundled]: 1 })
  expect(() => findBinary('vtr-tap', env(), fs)).toThrow(/not found/)
})

test('env override wins and must exist', () => {
  const fs = fakeFs({ '/custom/tap': 1, [bundled]: 2, [release]: 3 })
  expect(findBinary('vtr-tap', env({ isPackaged: true, envBin: '/custom/tap' }), fs)).toBe(
    '/custom/tap'
  )
  expect(() => findBinary('vtr-tap', env({ envBin: '/gone' }), fs)).toThrow(/override not found/)
})

test('name selects the binary in every location', () => {
  const playerBundled = '/App.app/Contents/Resources/bin/vtr-player'
  const playerRelease = join('/repo/vtr-editor', '../target/release/vtr-player')
  expect(
    findBinary(
      'vtr-player',
      env({ isPackaged: true }),
      fakeFs({ [playerBundled]: 1, [bundled]: 1 })
    )
  ).toBe(playerBundled)
  expect(findBinary('vtr-player', env(), fakeFs({ [playerRelease]: 1, [release]: 9 }))).toBe(
    playerRelease
  )
})
