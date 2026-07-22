import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const RECENTS_FILE = 'recent-projects.json'
const MAX_RECENTS = 10

/** Most-recent-first project paths for the File > Open Recent menu (userData). */
export function loadRecents(dataDir: string): string[] {
  try {
    const data = JSON.parse(readFileSync(join(dataDir, RECENTS_FILE), 'utf8'))
    return Array.isArray(data) ? data.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function writeRecents(dataDir: string, list: string[]): void {
  writeFileSync(join(dataDir, RECENTS_FILE), JSON.stringify(list, null, 2) + '\n')
}

/**
 * Put `path` on top. `normalize` dedupes entries that name the same project
 * through different paths (a .oscproj bundle vs its inner project.json).
 */
export function addRecent(
  dataDir: string,
  path: string,
  normalize: (p: string) => string = (p) => p
): string[] {
  const key = normalize(path)
  const rest = loadRecents(dataDir).filter((p) => normalize(p) !== key)
  const list = [path, ...rest].slice(0, MAX_RECENTS)
  writeRecents(dataDir, list)
  return list
}

export function removeRecent(dataDir: string, path: string): string[] {
  const list = loadRecents(dataDir).filter((p) => p !== path)
  writeRecents(dataDir, list)
  return list
}

export function clearRecents(dataDir: string): string[] {
  writeRecents(dataDir, [])
  return []
}
