/** Longest allowed timeline duration (24 h): an unbounded value would feed
 *  a multi-million-iteration ruler loop and a DOM width past layout limits. */
export const MAX_DURATION_S = 86400

/** Accepts arithmetic ("60*2" → 120); must come out positive. Clamped. */
export function parseDuration(draft: string): number | null {
  const n = evalExpr(draft)
  return n != null && n > 0 ? Math.min(n, MAX_DURATION_S) : null
}

/**
 * Evaluates an arithmetic expression: numbers, + - * /, parens, unary +/-.
 * Returns null on any syntax error or non-finite result.
 * (CSP blocks eval; a math library is overkill for four operators.)
 */
export function evalExpr(src: string): number | null {
  const s = src.replace(/\s+/g, '')
  let pos = 0

  const expr = (): number => {
    let v = term()
    for (;;) {
      if (s[pos] === '+') {
        pos++
        v += term()
      } else if (s[pos] === '-') {
        pos++
        v -= term()
      } else return v
    }
  }

  const term = (): number => {
    let v = factor()
    for (;;) {
      if (s[pos] === '*') {
        pos++
        v *= factor()
      } else if (s[pos] === '/') {
        pos++
        v /= factor()
      } else return v
    }
  }

  const factor = (): number => {
    if (s[pos] === '-') {
      pos++
      return -factor()
    }
    if (s[pos] === '+') {
      pos++
      return factor()
    }
    if (s[pos] === '(') {
      pos++
      const v = expr()
      if (s[pos] !== ')') throw new Error('expected )')
      pos++
      return v
    }
    const m = /^\d+(\.\d*)?|^\.\d+/.exec(s.slice(pos))
    if (!m) throw new Error('expected number')
    pos += m[0].length
    return parseFloat(m[0])
  }

  try {
    if (s === '') return null
    const v = expr()
    if (pos !== s.length) return null
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

export function parsePort(draft: string): number | null {
  const n = parseInt(draft, 10)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}
