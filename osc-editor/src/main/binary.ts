import { existsSync, statSync } from 'fs'
import { join } from 'path'

/** Everything findBinary needs from electron/process, injectable for tests. */
export interface BinaryEnv {
  /** app.isPackaged */
  isPackaged: boolean
  /** process.resourcesPath — Resources dir of a packaged app. */
  resourcesPath: string
  /** app.getAppPath() — repo checkout dir in dev. */
  appPath: string
  /** Env-var override (OSC_TAP_BIN / VTR_PLAYER_BIN). */
  envBin?: string
}

interface FsLike {
  existsSync: (p: string) => boolean
  statSync: (p: string) => { mtimeMs: number }
}

export const bundledBinaryPath = (resourcesPath: string, name: string): string =>
  join(resourcesPath, 'bin', name)

/**
 * Locate a workspace binary (osc-tap, vtr-player).
 * - The env override always wins (must exist).
 * - Packaged: the bundled copy (extraResources → Resources/bin/<name>).
 * - Dev: sibling cargo build; most recently built of release/debug wins so a
 *   stale build never shadows a fresh one.
 */
export function findBinary(
  name: string,
  env: BinaryEnv,
  fs: FsLike = { existsSync, statSync }
): string {
  if (env.envBin) {
    if (fs.existsSync(env.envBin)) return env.envBin
    throw new Error(`${name} override not found: ${env.envBin}`)
  }
  if (env.isPackaged) {
    const bundled = bundledBinaryPath(env.resourcesPath, name)
    if (fs.existsSync(bundled)) return bundled
  }
  const candidates = [
    join(env.appPath, `../osc-tap/target/release/${name}`),
    join(env.appPath, `../osc-tap/target/debug/${name}`)
  ].filter((p) => fs.existsSync(p))
  if (candidates.length === 0) {
    throw new Error(`${name} binary not found (build the osc-tap workspace or set the env override)`)
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return candidates[0]
}
