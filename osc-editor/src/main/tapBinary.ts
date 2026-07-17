import { existsSync, statSync } from 'fs'
import { join } from 'path'

/** Everything findTapBinary needs from electron/process, injectable for tests. */
export interface TapBinaryEnv {
  /** app.isPackaged */
  isPackaged: boolean
  /** process.resourcesPath — Resources dir of a packaged app. */
  resourcesPath: string
  /** app.getAppPath() — repo checkout dir in dev. */
  appPath: string
  /** OSC_TAP_BIN override. */
  envBin?: string
}

interface FsLike {
  existsSync: (p: string) => boolean
  statSync: (p: string) => { mtimeMs: number }
}

export const bundledTapPath = (resourcesPath: string): string =>
  join(resourcesPath, 'bin', 'osc-tap')

/**
 * Locate the osc-tap binary.
 * - OSC_TAP_BIN always wins (must exist).
 * - Packaged: the bundled copy (extraResources → Resources/bin/osc-tap).
 * - Dev: sibling cargo build; most recently built of release/debug wins so a
 *   stale build never shadows a fresh one.
 */
export function findTapBinary(env: TapBinaryEnv, fs: FsLike = { existsSync, statSync }): string {
  if (env.envBin) {
    if (fs.existsSync(env.envBin)) return env.envBin
    throw new Error(`OSC_TAP_BIN not found: ${env.envBin}`)
  }
  if (env.isPackaged) {
    const bundled = bundledTapPath(env.resourcesPath)
    if (fs.existsSync(bundled)) return bundled
  }
  const candidates = [
    join(env.appPath, '../osc-tap/target/release/osc-tap'),
    join(env.appPath, '../osc-tap/target/debug/osc-tap')
  ].filter((p) => fs.existsSync(p))
  if (candidates.length === 0) {
    throw new Error('osc-tap binary not found (build osc-tap or set OSC_TAP_BIN)')
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return candidates[0]
}
