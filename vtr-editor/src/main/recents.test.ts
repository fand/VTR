import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addRecent, clearRecents, loadRecents, removeRecent } from './recents'

const dir = (): string => mkdtempSync(join(tmpdir(), 'vtr-recents-'))

describe('recents', () => {
  it('returns [] with no file or a corrupt file', () => {
    const d = dir()
    expect(loadRecents(d)).toEqual([])
    writeFileSync(join(d, 'recent-projects.json'), 'not json')
    expect(loadRecents(d)).toEqual([])
    writeFileSync(join(d, 'recent-projects.json'), '{"a":1}')
    expect(loadRecents(d)).toEqual([])
  })

  it('adds newest first and moves an existing entry to the top', () => {
    const d = dir()
    addRecent(d, '/a.oscproj')
    addRecent(d, '/b.oscproj')
    expect(loadRecents(d)).toEqual(['/b.oscproj', '/a.oscproj'])
    addRecent(d, '/a.oscproj')
    expect(loadRecents(d)).toEqual(['/a.oscproj', '/b.oscproj'])
  })

  it('dedupes through the normalize hook', () => {
    const d = dir()
    const normalize = (p: string): string => (p.endsWith('.oscproj') ? join(p, 'project.json') : p)
    addRecent(d, '/x/p.oscproj', normalize)
    addRecent(d, '/x/p.oscproj/project.json', normalize)
    expect(loadRecents(d)).toEqual(['/x/p.oscproj/project.json'])
  })

  it('caps the list at 10', () => {
    const d = dir()
    for (let i = 0; i < 12; i++) addRecent(d, `/p${i}.oscproj`)
    const list = loadRecents(d)
    expect(list).toHaveLength(10)
    expect(list[0]).toBe('/p11.oscproj')
    expect(list[9]).toBe('/p2.oscproj')
  })

  it('removes and clears', () => {
    const d = dir()
    addRecent(d, '/a.oscproj')
    addRecent(d, '/b.oscproj')
    expect(removeRecent(d, '/a.oscproj')).toEqual(['/b.oscproj'])
    expect(loadRecents(d)).toEqual(['/b.oscproj'])
    expect(clearRecents(d)).toEqual([])
    expect(loadRecents(d)).toEqual([])
  })
})
