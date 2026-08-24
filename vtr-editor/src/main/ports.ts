import { DEFAULT_PORTS, RELAY_PORT, type PortConfig } from '../shared/types'

/**
 * Port overrides from the environment. The relay port and the untitled
 * session's ports are otherwise fixed constants, so a second editor (an e2e
 * run beside a live dev instance) would fight the first one for them.
 */
function envPort(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

/** Loopback port the tap relays /vtr/* to and the player listens on. */
export const relayPort = (): number => envPort('VTR_RELAY_PORT', RELAY_PORT)

/** Ports for a session with no project file to read them from. */
export const defaultPorts = (): PortConfig => ({
  ...DEFAULT_PORTS,
  listen: envPort('VTR_LISTEN_PORT', DEFAULT_PORTS.listen),
  forward: envPort('VTR_FORWARD_PORT', DEFAULT_PORTS.forward),
  echo: envPort('VTR_ECHO_PORT', DEFAULT_PORTS.echo)
})
