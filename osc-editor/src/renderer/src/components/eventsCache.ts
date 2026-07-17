import type { OscEvent } from '../../../shared/types'

/** Clip files are immutable, so raw events cache forever. */
export const eventsCache = new Map<string, OscEvent[]>()

/** Drop cached events on project open: paths can repeat across bundles,
 *  and the module-level cache would otherwise grow without bound. */
export function clearEventsCache(): void {
  eventsCache.clear()
}
