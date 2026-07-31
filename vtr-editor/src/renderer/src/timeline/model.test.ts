import { describe, expect, it } from 'vitest'
import {
  formatRulerLabel,
  formatTimecode,
  gridStep,
  pickStep,
  rulerStep,
  stepDecimals,
  TIME_TICK_MIN_PX
} from './model'

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

describe('pickStep', () => {
  it('takes the first step at least minPx apart', () => {
    expect(pickStep([1, 2, 5], 10, 100, 20)).toBe(2)
    expect(pickStep([1, 2, 5], 10, 100, 10)).toBe(1)
  })

  it('falls back to the coarsest step when none fits', () => {
    expect(pickStep([1, 2, 5], 1000, 100, 90)).toBe(5)
  })
})

describe('rulerStep', () => {
  it('coarsens as the timeline zooms out', () => {
    expect(rulerStep(400)).toBe(0.25)
    expect(rulerStep(100)).toBe(1)
    expect(rulerStep(2)).toBe(60)
  })

  // The whole point of the shared minimum: HH:MM:SS.mmm labels never collide.
  it('keeps ticks a label width apart across the zoom range', () => {
    for (let pxPerSec = 2; pxPerSec <= 400; pxPerSec += 2) {
      expect(rulerStep(pxPerSec) * pxPerSec).toBeGreaterThanOrEqual(TIME_TICK_MIN_PX)
    }
  })
})

describe('gridStep', () => {
  it('scales the time axis by the same label width as the ruler', () => {
    expect(gridStep(1, 900, TIME_TICK_MIN_PX)).toBe(0.1)
    expect(gridStep(10, 900, TIME_TICK_MIN_PX)).toBe(1)
  })

  it('goes finer than the ruler for the value axis', () => {
    expect(gridStep(0.05, 180, 18)).toBe(0.005)
  })

  it('falls back to the coarsest step when zoomed all the way out', () => {
    expect(gridStep(1e6, 100, TIME_TICK_MIN_PX)).toBe(120)
  })
})

describe('stepDecimals', () => {
  it('counts the decimals a step needs', () => {
    expect(stepDecimals(30)).toBe(0)
    expect(stepDecimals(1)).toBe(0)
    expect(stepDecimals(0.25)).toBe(1)
    expect(stepDecimals(0.001)).toBe(3)
  })
})
