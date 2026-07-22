import { expect, test, vi } from 'vitest'
import { TransportFollow, type Watchable } from './transportFollow'
import type { TransportState } from '../shared/types'

/** A fake player whose watch() drains a scripted queue, then blocks. */
function scripted(states: (TransportState | 'error')[]): Watchable {
  let i = 0
  return {
    watch: async () => {
      const s = states[i++]
      if (s === undefined) return new Promise<TransportState>(() => {}) // hang
      if (s === 'error') throw new Error('player down')
      return s
    }
  }
}

const st = (gen: number, origin: string, extra?: Partial<TransportState>): TransportState => ({
  gen,
  origin,
  playhead: 0,
  playing: false,
  ...extra
})

async function flush(): Promise<void> {
  // Real timers: the reconnect path yields to setTimeout between watches.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1))
}

test('foreign changes are forwarded, editor echoes suppressed', async () => {
  const seen: TransportState[] = []
  const f = new TransportFollow(
    scripted([st(1, 'td', { playhead: 2 }), st(2, 'editor'), st(3, 'osc', { playing: true })]),
    (s) => seen.push(s)
  )
  f.start()
  await flush()
  f.stop()
  expect(seen.map((s) => [s.gen, s.origin])).toEqual([
    [1, 'td'],
    [3, 'osc']
  ])
})

test('a repeated gen (timeout) is not re-applied', async () => {
  const seen: TransportState[] = []
  const f = new TransportFollow(scripted([st(5, 'td'), st(5, 'td'), st(6, 'td')]), (s) =>
    seen.push(s)
  )
  f.start()
  await flush()
  f.stop()
  expect(seen.map((s) => s.gen)).toEqual([5, 6])
})

test('a watch error re-baselines from gen 0', async () => {
  const gens: number[] = []
  const player: Watchable = {
    watch: vi.fn(async (gen: number) => {
      gens.push(gen)
      if (gens.length === 1) throw new Error('down')
      if (gens.length === 2) return st(4, 'td')
      return new Promise<TransportState>(() => {})
    })
  }
  const seen: TransportState[] = []
  const f = new TransportFollow(player, (s) => seen.push(s), 0)
  f.start()
  await flush()
  f.stop()
  // First call used gen 0, errored; after reset it watched from 0 again.
  expect(gens.slice(0, 2)).toEqual([0, 0])
  expect(seen.map((s) => s.gen)).toEqual([4])
})
