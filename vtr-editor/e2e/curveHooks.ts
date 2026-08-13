import { expect, type Page } from '@playwright/test'

/** Curve geometry test hooks: the curve editor paints curves/points on a
 *  canvas, so tests read their geometry from window.__curveProps /
 *  __curvePoints (client coordinates) instead of DOM nodes. Selected point
 *  handles are still real `circle.selected` SVG elements. */

export interface CurvePointHook {
  label: string
  /** Client (page) coordinates — pass straight to page.mouse. */
  x: number
  y: number
  selected: boolean
  t: number
  v: number
}

export interface CurvePropHook {
  key: string
  label: string
  selected: boolean
  dimmed: boolean
  pointCount: number
  curveCount: number
}

export interface CurveKnotHook {
  label: string
  /** Client (page) coordinates — pass straight to page.mouse. */
  x: number
  y: number
  t: number
  v: number
  selected: boolean
  /** Step segment leaving this knot. */
  s: boolean
  hasIn: boolean
  hasOut: boolean
}

export const curvePoints = (page: Page): Promise<CurvePointHook[]> =>
  page.evaluate(() => (window as Window & { __curvePoints?: CurvePointHook[] }).__curvePoints ?? [])

export const curveProps = (page: Page): Promise<CurvePropHook[]> =>
  page.evaluate(() => (window as Window & { __curveProps?: CurvePropHook[] }).__curveProps ?? [])

export const curveKnots = (page: Page): Promise<CurveKnotHook[]> =>
  page.evaluate(() => (window as Window & { __curveKnots?: CurveKnotHook[] }).__curveKnots ?? [])

/** Poll-asserts one property's drawn point and bezier-curve counts. */
export const expectPropCounts = (
  page: Page,
  label: string,
  points: number,
  curves: number
): Promise<void> =>
  expect
    .poll(() =>
      curveProps(page).then((c) => {
        const p = c.find((p) => p.label === label)
        return p && { points: p.pointCount, curves: p.curveCount }
      })
    )
    .toEqual({ points, curves })

/** Poll-asserts the drawn (non-dimmed) point count. */
export const expectPointCount = (page: Page, n: number): Promise<void> =>
  expect.poll(() => curvePoints(page).then((p) => p.length)).toBe(n)

/** Poll-asserts the drawn curve count (dimmed curves included). */
export const expectCurveCount = (page: Page, n: number): Promise<void> =>
  expect.poll(() => curveProps(page).then((p) => p.length)).toBe(n)

export const expectPropDimmed = (page: Page, label: string, dimmed: boolean): Promise<void> =>
  expect
    .poll(() => curveProps(page).then((c) => c.find((p) => p.label === label)?.dimmed))
    .toBe(dimmed)

export const expectPropSelected = (page: Page, label: string, selected: boolean): Promise<void> =>
  expect
    .poll(() => curveProps(page).then((c) => c.find((p) => p.label === label)?.selected))
    .toBe(selected)

export const expectPropDrawn = (page: Page, label: string, drawn: boolean): Promise<void> =>
  expect.poll(() => curveProps(page).then((c) => c.some((p) => p.label === label))).toBe(drawn)
