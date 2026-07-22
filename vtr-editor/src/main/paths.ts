import { resolve, sep } from 'path'

/** True when p resolves to root itself or somewhere inside it. */
export function isWithin(root: string, p: string): boolean {
  const r = resolve(root)
  const q = resolve(p)
  return q === r || q.startsWith(r + sep)
}

/**
 * Resolve a renderer-supplied path and require it inside one of the roots
 * (nulls skipped). IPC handlers use this so a hostile path can't reach
 * arbitrary files.
 */
export function ensureWithin(roots: (string | null)[], p: string): string {
  const q = resolve(p)
  for (const root of roots) {
    if (root && isWithin(root, q)) return q
  }
  throw new Error(`path outside allowed directories: ${p}`)
}

/** A clip file reference must be a bare file name — no traversal, no dirs. */
export function isSafeClipFile(file: string): boolean {
  return (
    file.length > 0 &&
    !file.includes('/') &&
    !file.includes('\\') &&
    !file.includes('\0') &&
    file !== '.' &&
    file !== '..'
  )
}
