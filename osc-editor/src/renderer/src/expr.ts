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
