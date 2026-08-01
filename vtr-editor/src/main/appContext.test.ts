import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { AppContext } from './appContext'

const ctx = (): AppContext => new AppContext('/work', '/data', '/data/recordings', true)

describe('project path grants', () => {
  it('refuses a path no dialog granted', () => {
    expect(() => ctx().requireGranted('/anywhere/evil.oscproj')).toThrow(/not granted/)
  })

  it('accepts a granted path, normalized to its project.json', () => {
    const c = ctx()
    c.grantProjectPath('/p/Foo.oscproj')
    expect(c.requireGranted('/p/Foo.oscproj')).toBe(join('/p/Foo.oscproj', 'project.json'))
  })

  it('grants the bundle and its project.json interchangeably', () => {
    const c = ctx()
    c.grantProjectPath('/p/Foo.oscproj')
    expect(() => c.requireGranted(join('/p/Foo.oscproj', 'project.json'))).not.toThrow()
  })

  it('a flat project.json grant stays exact', () => {
    const c = ctx()
    c.grantProjectPath('/p/project.json')
    expect(c.requireGranted('/p/project.json')).toBe('/p/project.json')
    expect(() => c.requireGranted('/p/other.json')).toThrow(/not granted/)
  })
})

describe('project-relative paths', () => {
  it('undoDir and clip paths fall back to userData / workdir when untitled', () => {
    const c = ctx()
    expect(c.undoDir()).toBe('/data')
    expect(c.clipRoots()).toEqual(['/work', '/data/recordings'])
    expect(c.resolveClip('a.jsonl')).toBe(join('/work', 'clips', 'a.jsonl'))
  })

  it('follow projectDir once a project is open', () => {
    const c = ctx()
    c.projectDir = '/p/Foo.oscproj'
    expect(c.undoDir()).toBe('/p/Foo.oscproj')
    expect(c.clipRoots()).toEqual(['/p/Foo.oscproj', '/data/recordings'])
    expect(c.resolveClip('a.jsonl')).toBe(join('/p/Foo.oscproj', 'clips', 'a.jsonl'))
  })
})

describe('child process guards', () => {
  it('surface the spawn error when the child is missing', () => {
    const c = ctx()
    c.tapError = 'no such binary: vtr-tap'
    expect(() => c.requireTap()).toThrow('no such binary: vtr-tap')
    expect(() => c.requirePlayer()).toThrow('vtr-player not running')
  })
})
