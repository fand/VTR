/** Replace-with-curve: turn a set of covered clip events into bezier curve
 *  overlay records plus the matching event deletions. Pure (no DOM) so it
 *  unit-tests with vitest; CurvePanel supplies the covered events from the
 *  current selection. */
import { clipCurve, fitCurve } from '../../../shared/curve'
import type { ClipCurve, OscEvent } from '../../../shared/types'

/** Fit tolerance in normalized space (t by group span, v by value range). */
export const FIT_ERROR = 0.01

/** A selected property needs this many points (per clip) to convert. */
export const MIN_FIT_POINTS = 3

/** One covered event: identified by its edit key, valued by its edited form. */
export interface ReplaceInput {
  /** Clip file (ClipEdits key space). */
  file: string
  eventIndex: number
  /** The edited event (clip-local t, post-overlay args). */
  ev: OscEvent
}

export interface CurveReplace {
  /** Events to delete, deduplicated. */
  dels: { file: string; eventIndex: number }[]
  /** Curves to append to each file's overlay (clip-local t). */
  adds: { file: string; curve: ClipCurve }[]
}

/**
 * Deleting an event removes every arg's point, not just the fitted
 * property's — so each numeric arg of the covered events is fitted as its
 * own curve (per file + port + address), and an event is only deleted when
 * every one of its numeric args is carried by a curve: no sibling data is
 * lost. Returns null when nothing produces a fittable curve.
 */
export function buildCurveReplace(inputs: ReplaceInput[]): CurveReplace | null {
  // Dedup events (a multi-arg event arrives once per selected property).
  const events = new Map<string, ReplaceInput>()
  for (const input of inputs) {
    events.set(`${input.file}:${input.eventIndex}`, input)
  }
  // Group by file + port + address; each numeric arg fits separately.
  const groups = new Map<string, ReplaceInput[]>()
  for (const input of events.values()) {
    const key = `${input.file} ${input.ev.port} ${input.ev.a}`
    let list = groups.get(key)
    if (!list) groups.set(key, (list = []))
    list.push(input)
  }
  const adds: CurveReplace['adds'] = []
  const fitted = new Set<string>() // files:eventIndex covered by curves
  for (const list of groups.values()) {
    list.sort((a, b) => a.ev.t - b.ev.t)
    const argCount = Math.max(...list.map((i) => i.ev.args.length))
    const fittedArgs = new Set<number>()
    for (let arg = 0; arg < argCount; arg++) {
      const carriers = list.filter((i) => typeof i.ev.args[arg] === 'number')
      const points = carriers.map((i) => ({ t: i.ev.t, v: i.ev.args[arg] as number }))
      if (points.length < 2) continue
      const knots = fitCurve(points, FIT_ERROR)
      if (!knots) continue
      // Template from an event that actually has this arg: the earliest
      // one's args can be shorter than `arg` when arg counts vary.
      const tpl = carriers[0].ev
      adds.push({
        file: list[0].file,
        curve: {
          port: tpl.port,
          a: tpl.a,
          arg,
          args: [...tpl.args],
          types: tpl.types,
          knots
        }
      })
      fittedArgs.add(arg)
    }
    // Delete only events whose every numeric arg is carried by a curve;
    // a lone extra arg (too few points to fit) keeps its event visible
    // instead of silently dropping the value.
    for (const i of list) {
      const covered = i.ev.args.every((a, ai) => typeof a !== 'number' || fittedArgs.has(ai))
      if (covered && fittedArgs.size > 0) fitted.add(`${i.file}:${i.eventIndex}`)
    }
  }
  if (adds.length === 0) return null
  // An unfittable group (e.g. all-duplicate times) keeps its points.
  const dels = [...events.values()]
    .filter((i) => fitted.has(`${i.file}:${i.eventIndex}`))
    .map(({ file, eventIndex }) => ({ file, eventIndex }))
  return { dels, adds }
}

/**
 * Carve `added`'s span out of the overlay curves that share its
 * (port, a, arg): overlapping curves are deleted and their out-of-span
 * remainders re-appended, so one clip never holds two curves competing for
 * the same time range. `existing` is the overlay's curves array with
 * already-deleted entries as undefined (indices are curveDel keys).
 */
export function subtractCurveOverlap(
  existing: (ClipCurve | undefined)[],
  added: ClipCurve
): { dels: number[]; remainders: ClipCurve[] } {
  const t0 = added.knots[0].t
  const t1 = added.knots[added.knots.length - 1].t
  const dels: number[] = []
  const remainders: ClipCurve[] = []
  existing.forEach((c, i) => {
    if (!c || c.port !== added.port || c.a !== added.a || c.arg !== added.arg) return
    const start = c.knots[0].t
    const end = c.knots[c.knots.length - 1].t
    if (end <= t0 || start >= t1) return
    dels.push(i)
    const left = clipCurve(c.knots, -Infinity, t0)
    if (left) remainders.push({ ...c, knots: left })
    const right = clipCurve(c.knots, t1, Infinity)
    if (right) remainders.push({ ...c, knots: right })
  })
  return { dels, remainders }
}
