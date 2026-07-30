import { afterEach, describe, expect, it } from 'vitest'
import { envDialogs } from './dialogs'

// The env stand-ins never touch the window.
const win = null as never

const setEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  delete process.env.OSC_EDITOR_QUIT_CHOICE
  delete process.env.OSC_EDITOR_DIALOG_PATH
})

describe('OSC_EDITOR_QUIT_CHOICE', () => {
  it('defaults to discard (documented no-autosave quit)', () => {
    expect(envDialogs.quitChoice(win)).toBe('discard')
    setEnv('OSC_EDITOR_QUIT_CHOICE', 'bogus')
    expect(envDialogs.quitChoice(win)).toBe('discard')
  })

  it('maps save and cancel through', () => {
    setEnv('OSC_EDITOR_QUIT_CHOICE', 'save')
    expect(envDialogs.quitChoice(win)).toBe('save')
    setEnv('OSC_EDITOR_QUIT_CHOICE', 'cancel')
    expect(envDialogs.quitChoice(win)).toBe('cancel')
  })

  it('only cancel blocks a discard-and-open', () => {
    expect(envDialogs.confirmDiscardForOpen(win)).toBe(true)
    setEnv('OSC_EDITOR_QUIT_CHOICE', 'cancel')
    expect(envDialogs.confirmDiscardForOpen(win)).toBe(false)
  })
})

describe('OSC_EDITOR_DIALOG_PATH', () => {
  it('open: unset and empty both mean no pick', async () => {
    expect(await envDialogs.openProject(win, '/dir')).toBeNull()
    setEnv('OSC_EDITOR_DIALOG_PATH', '')
    expect(await envDialogs.openProject(win, '/dir')).toBeNull()
    setEnv('OSC_EDITOR_DIALOG_PATH', '/p/Foo.oscproj')
    expect(await envDialogs.openProject(win, '/dir')).toBe('/p/Foo.oscproj')
  })

  it('save: unset falls back to the suggestion, empty means cancelled', async () => {
    expect(await envDialogs.saveProject(win, '/dir/Untitled.oscproj')).toBe('/dir/Untitled.oscproj')
    setEnv('OSC_EDITOR_DIALOG_PATH', '')
    expect(await envDialogs.saveProject(win, '/dir/Untitled.oscproj')).toBeNull()
    setEnv('OSC_EDITOR_DIALOG_PATH', '/p/Bar.oscproj')
    expect(await envDialogs.saveProject(win, '/p/Bar.oscproj')).toBe('/p/Bar.oscproj')
  })

  it('export: always writes the default path', async () => {
    setEnv('OSC_EDITOR_DIALOG_PATH', '')
    expect(await envDialogs.exportSessionPath(win, '/dir/session.jsonl')).toBe('/dir/session.jsonl')
  })
})
