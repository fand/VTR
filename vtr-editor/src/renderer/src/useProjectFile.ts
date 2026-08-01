import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  DEFAULT_DURATION,
  normalizePorts,
  type LoadedProject,
  type PortConfig,
  type UndoEntry
} from '../../shared/types'
import { clearEventsCache } from './components/eventsCache'
import type { Doc } from './history'
import { markersFromProject, serializeProject, tracksFromProject } from './timeline/model'

/**
 * The open project file: boot load, open/save/save-as, export, dirty
 * tracking, window title. Owns projectFile and the last-saved snapshot;
 * the doc itself stays in useHistory.
 */
export function useProjectFile(opts: {
  reset: (doc: Doc, past: UndoEntry[], future: UndoEntry[]) => void
  /** Current doc + undo seq, serialized on save/export. */
  doc: Doc
  seq: number
  ports: PortConfig
  setPorts: (p: PortConfig) => void
  newId: () => number
  clearSelection: () => void
  /** Project switched: clipboard and caches referencing old files must drop. */
  onProjectSwitched: () => void
  setError: (msg: string | null) => void
  setLog: (msg: string) => void
}): {
  projectFile: string | null
  fileName: string | undefined
  dirty: boolean
  bootDone: boolean
  saveProject: () => Promise<boolean>
  saveProjectAs: () => Promise<boolean>
  openProject: () => Promise<void>
  doExport: () => Promise<void>
} {
  const { reset, setPorts, newId, clearSelection, onProjectSwitched, setError, setLog } = opts

  // Current project file (null = untitled) and the last-saved snapshot.
  // Dirty = the doc's undo seq or the ports moved off that snapshot.
  const [projectFile, setProjectFile] = useState<string | null>(null)
  const [savedState, setSavedState] = useState<{ seq: number; ports: PortConfig }>({
    seq: 0,
    ports: opts.ports
  })

  // Install a loaded project (boot or File > Open) into the editor.
  const applyLoaded = useCallback(
    (path: string | null, project: LoadedProject | null, log: UndoEntry[]): void => {
      let doc: Doc = { tracks: [], markers: [], duration: DEFAULT_DURATION, edits: {} }
      let loadedPorts: PortConfig | null = null
      if (project) {
        doc = {
          tracks: tracksFromProject(project, newId),
          markers: markersFromProject(project, newId),
          duration: project.duration ?? DEFAULT_DURATION,
          edits: project.edits
        }
        if (project.ports) {
          // Back-fill echo and drop the legacy beacon key on older files.
          loadedPorts = normalizePorts(project.ports)
          setPorts(loadedPorts)
          window.api.tap.setPorts(loadedPorts).catch((e: Error) => setError(e.message))
        }
        if (project.missing.length > 0) {
          setError(`missing clip files: ${project.missing.join(', ')}`)
        }
      }
      // undoSeq is the cursor: entries at or below it are undoable from the
      // saved state, later ones are redo (incl. crash-recovery tails).
      const cursor = project?.undoSeq ?? Math.max(0, ...log.map((e) => e.seq))
      const pastLog = log.filter((e) => e.seq <= cursor)
      reset(
        doc,
        pastLog,
        log.filter((e) => e.seq > cursor)
      )
      setProjectFile(path)
      setSavedState((s) => ({
        seq: pastLog[pastLog.length - 1]?.seq ?? 0,
        ports: loadedPorts ?? s.ports
      }))
      clearSelection()
      clearEventsCache()
      onProjectSwitched()
    },
    [newId, reset, setPorts, clearSelection, onProjectSwitched, setError]
  )

  // Boot: open the CLI-arg project if one was given, otherwise an empty
  // project. A broken project file reports the error and falls back to empty.
  // The undo log only applies to the loaded project.
  const booted = useRef(false)
  const [bootDone, setBootDone] = useState(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    const boot = async (): Promise<void> => {
      let loaded: { path: string; project: LoadedProject } | null = null
      try {
        loaded = await window.api.project.load()
      } catch (e) {
        setError(`failed to open project: ${(e as Error).message}`)
      }
      const log = loaded ? await window.api.undo.load() : []
      applyLoaded(loaded?.path ?? null, loaded?.project ?? null, log)
    }
    boot()
      .catch((e: Error) => setError(e.message))
      .finally(() => setBootDone(true))
  }, [applyLoaded, setError])

  // Menu/keydown listeners read state through refs, so a save fired right
  // after a commit (record stop → immediate Cmd+S) can't run against a
  // stale closure and silently drop the newest change from project.json.
  // The layout effect updates it synchronously with the DOM commit, so it
  // is current as soon as the change is visible — not one passive-effect
  // flush later.
  const saveState = useRef({ doc: opts.doc, ports: opts.ports, seq: opts.seq })
  useLayoutEffect(() => {
    saveState.current = { doc: opts.doc, ports: opts.ports, seq: opts.seq }
  })

  const saveTo = useCallback(
    async (path: string): Promise<void> => {
      const s = saveState.current
      await window.api.project.save(
        path,
        serializeProject(s.doc.tracks, s.doc.markers, s.ports, s.doc.duration, s.doc.edits, s.seq)
      )
      setProjectFile(path)
      setSavedState({ seq: s.seq, ports: s.ports })
      setLog(`Saved ${path.split(/[\\/]/).pop()}`)
    },
    [setLog]
  )

  /** Resolves true only when the project actually saved (dialog not cancelled). */
  const saveProjectAs = useCallback(async (): Promise<boolean> => {
    try {
      const path = await window.api.project.saveDialog(projectFile ?? undefined)
      if (!path) return false
      await saveTo(path)
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    }
  }, [projectFile, saveTo, setError])

  const saveProject = useCallback(async (): Promise<boolean> => {
    if (!projectFile) return saveProjectAs()
    try {
      await saveTo(projectFile)
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    }
  }, [projectFile, saveTo, saveProjectAs, setError])

  const openPath = useCallback(
    async (path: string): Promise<void> => {
      try {
        const res = await window.api.project.loadPath(path)
        // The bundle carries its own undo log; restore it like boot does.
        const undoLog = await window.api.undo.load()
        applyLoaded(res.path, res.project, undoLog)
        setLog(`Opened ${res.path.split(/[\\/]/).pop()}`)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [applyLoaded, setError, setLog]
  )

  const openProject = useCallback(async (): Promise<void> => {
    try {
      const path = await window.api.project.openDialog()
      if (path) await openPath(path)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [openPath, setError])

  // Finder open of a .oscproj while the app is running (main prompts for
  // unsaved changes before sending this).
  useEffect(() => window.api.project.onOpenPath(openPath), [openPath])

  const doExport = useCallback(async () => {
    const s = saveState.current
    try {
      const result = await window.api.session.export(
        serializeProject(s.doc.tracks, s.doc.markers, s.ports, s.doc.duration, s.doc.edits, s.seq)
      )
      if (!result) return // save dialog cancelled
      setLog(`Exported ${result.path} (${result.events} events, ${result.duration.toFixed(1)}s)`)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [setError, setLog])

  // Window title: "VTR - <file> (edited)"; parts drop off when there is
  // no open file / no unsaved change. macOS hides the native bar (custom
  // title bar) but the title still names the window in Mission Control;
  // setFile keeps the edited dot on the close button.
  const dirty = opts.seq !== savedState.seq || opts.ports !== savedState.ports
  const fileName = projectFile?.split(/[\\/]/).pop()
  useEffect(() => {
    document.title = `VTR${fileName ? ` - ${fileName}` : ''}${dirty ? ' (edited)' : ''}`
    window.api.window.setFile(projectFile ?? null, dirty)
  }, [projectFile, fileName, dirty])

  return {
    projectFile,
    fileName,
    dirty,
    bootDone,
    saveProject,
    saveProjectAs,
    openProject,
    doExport
  }
}
