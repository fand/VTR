import { describe, expect, it } from 'vitest'
import type { MonitorLine } from '../../../shared/types'
import { appendRows, formatMonitorLine, MONITOR_MAX_LINES } from './monitorModel'

function line(over: Partial<MonitorLine> = {}): MonitorLine {
  return {
    wall: new Date(2026, 0, 2, 3, 4, 5, 67).getTime(),
    port: 10010,
    a: '/fader',
    types: 'f',
    args: [0.5],
    from: '127.0.0.1:9000',
    ...over
  }
}

describe('formatMonitorLine', () => {
  it('renders local time, address, and args', () => {
    expect(formatMonitorLine(line())).toBe('03:04:05.067 /fader 0.5')
  })

  it('quotes string args and joins several', () => {
    expect(formatMonitorLine(line({ types: 'sf', args: ['go', 1] }))).toBe(
      '03:04:05.067 /fader "go" 1'
    )
  })

  it('omits the args tail for arg-less messages', () => {
    expect(formatMonitorLine(line({ types: '', args: [] }))).toBe('03:04:05.067 /fader')
  })
})

describe('appendRows', () => {
  it('appends with monotonically growing keys', () => {
    const key = { current: 0 }
    const a = appendRows([], [line(), line()], key)
    const b = appendRows(a, [line()], key)
    expect(b.map((r) => r.key)).toEqual([0, 1, 2])
  })

  it('drops the oldest rows beyond the cap', () => {
    const key = { current: 0 }
    let rows = appendRows(
      [],
      Array.from({ length: MONITOR_MAX_LINES }, () => line()),
      key
    )
    rows = appendRows(rows, [line({ a: '/new' })], key)
    expect(rows.length).toBe(MONITOR_MAX_LINES)
    expect(rows[0].key).toBe(1)
    expect(rows[rows.length - 1].text).toContain('/new')
  })
})
