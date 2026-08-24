import { join } from 'node:path'

/**
 * Launch env for an e2e editor. Every spec owns a port block off `base`:
 * +0 listen, +1 forward, +2 echo, +3 relay. A spec's project file sets its
 * own listen/forward, but the untitled-session ports and the tap↔player
 * relay port are constants in the app, so they need these overrides — else
 * the run fights a live dev instance (or another spec) for 10010/10013.
 */
export function e2eEnv(
  base: number,
  workdir: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v != null) inherited[k] = v
  return {
    ...inherited,
    VTR_TAP_BIN: join(__dirname, '../../target/debug/vtr-tap'),
    // Preview is delegated to vtr-player; findBinary can't see the cargo
    // tree from out/main, so point straight at the debug build.
    VTR_PLAYER_BIN: join(__dirname, '../../target/debug/vtr-player'),
    VTR_LISTEN_PORT: String(base),
    VTR_FORWARD_PORT: String(base + 1),
    VTR_ECHO_PORT: String(base + 2),
    VTR_RELAY_PORT: String(base + 3),
    OSC_EDITOR_HIDDEN: '1',
    OSC_EDITOR_DATA_DIR: workdir,
    ...extra
  }
}
