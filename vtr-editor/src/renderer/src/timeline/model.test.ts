import { describe, expect, it } from 'vitest'
import { formatRulerLabel, formatTimecode } from './model'

describe('formatTimecode', () => {
  it('formats HH:MM:SS.mmm', () => {
    expect(formatTimecode(0)).toBe('00:00:00.000')
    expect(formatTimecode(1.5)).toBe('00:00:01.500')
    expect(formatTimecode(61.25)).toBe('00:01:01.250')
    expect(formatTimecode(3600)).toBe('01:00:00.000')
  })

  it('rounds float noise to the nearest ms', () => {
    // 0.1 * 3 = 0.30000000000000004
    expect(formatTimecode(0.1 * 3)).toBe('00:00:00.300')
    expect(formatTimecode(0.2999999997)).toBe('00:00:00.300')
  })
})

describe('formatRulerLabel', () => {
  it('keeps ms for sub-second steps', () => {
    expect(formatRulerLabel(0.25, 0.25)).toBe('00:00:00.250')
    expect(formatRulerLabel(1.5, 0.5)).toBe('00:00:01.500')
    expect(formatRulerLabel(0.006, 0.002)).toBe('00:00:00.006')
  })

  it('drops ms for whole-second steps', () => {
    expect(formatRulerLabel(0, 1)).toBe('00:00:00')
    expect(formatRulerLabel(90, 30)).toBe('00:01:30')
    expect(formatRulerLabel(3600, 300)).toBe('01:00:00')
  })
})
