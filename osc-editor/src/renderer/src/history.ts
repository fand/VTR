import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer'
import { useCallback, useRef, useState } from 'react'
import type { ClipEdits, UndoEntry } from '../../shared/types'
import type { TrackState } from './timeline/model'

enablePatches()

/** Everything undoable. Ports (device config) and view state stay outside. */
export interface Doc {
  tracks: TrackState[]
  duration: number
  edits: Record<string, ClipEdits>
}

/** In-memory history cap; the on-disk log is capped in the main process. */
const MAX_ENTRIES = 1000

export interface History {
  doc: Doc
  /** Version (undo seq) of the current doc; saved as project.json undoSeq. */
  seq: number
  canUndo: boolean
  canRedo: boolean
  /** Install the loaded doc and the persisted undo log (boot only). */
  reset: (doc: Doc, past: UndoEntry[], future: UndoEntry[]) => void
  /** Update the doc without recording. The first transient in a gesture pins
   *  the base; the following commit produces patches from it, so a whole drag
   *  is one entry. */
  transient: (recipe: (d: Doc) => void) => void
  /** Record one undoable change. The recipe must set final absolute values —
   *  it is (re)applied to the pre-gesture base, not the transient doc. */
  commit: (label: string, recipe: (d: Doc) => void) => void
  undo: () => void
  redo: () => void
}

export function useHistory(initial: Doc, onRestore: (doc: Doc) => void): History {
  const [doc, setDoc] = useState(initial)
  const docRef = useRef(doc)
  const base = useRef<Doc | null>(null)
  const past = useRef<UndoEntry[]>([])
  const future = useRef<UndoEntry[]>([])
  const nextSeq = useRef(1)
  // Stacks live in refs; render-facing facts about them live in state.
  const [meta, setMeta] = useState({ seq: 0, canUndo: false, canRedo: false })

  const install = useCallback((next: Doc): void => {
    docRef.current = next
    setDoc(next)
    setMeta({
      seq: past.current[past.current.length - 1]?.seq ?? 0,
      canUndo: past.current.length > 0,
      canRedo: future.current.length > 0
    })
  }, [])

  const reset = useCallback(
    (d: Doc, p: UndoEntry[], f: UndoEntry[]): void => {
      past.current = p
      future.current = f
      nextSeq.current = Math.max(0, ...p.map((e) => e.seq), ...f.map((e) => e.seq)) + 1
      base.current = null
      install(d)
    },
    [install]
  )

  const transient = useCallback(
    (recipe: (d: Doc) => void): void => {
      base.current ??= docRef.current
      install(produce(docRef.current, recipe))
    },
    [install]
  )

  const commit = useCallback(
    (label: string, recipe: (d: Doc) => void): void => {
      const from = base.current ?? docRef.current
      base.current = null
      const [next, patches, inversePatches] = produceWithPatches(from, recipe)
      if (patches.length === 0) {
        // No-op commit still snaps any transient state back to the base.
        install(next)
        return
      }
      if (future.current.length > 0) {
        // Linear history: a new commit discards the redo branch.
        future.current = []
        const top = past.current[past.current.length - 1]
        window.api.undo.truncateAfter(top?.seq ?? 0).catch(() => {})
      }
      const entry: UndoEntry = { seq: nextSeq.current++, label, patches, inversePatches }
      past.current.push(entry)
      if (past.current.length > MAX_ENTRIES) past.current.shift()
      window.api.undo.append(entry).catch(() => {})
      install(next)
    },
    [install]
  )

  const restore = useCallback(
    (next: Doc): void => {
      base.current = null
      install(next)
      onRestore(next)
    },
    [install, onRestore]
  )

  /** A patch that no longer fits the doc means log/state divergence: drop history. */
  const dropHistory = useCallback((): void => {
    past.current = []
    future.current = []
    window.api.undo.truncateAfter(0).catch(() => {})
    install(docRef.current)
  }, [install])

  const undo = useCallback((): void => {
    const entry = past.current.pop()
    if (!entry) return
    try {
      const next = applyPatches(docRef.current, entry.inversePatches)
      future.current.unshift(entry)
      restore(next)
    } catch {
      dropHistory()
    }
  }, [restore, dropHistory])

  const redo = useCallback((): void => {
    const entry = future.current.shift()
    if (!entry) return
    try {
      const next = applyPatches(docRef.current, entry.patches)
      past.current.push(entry)
      restore(next)
    } catch {
      dropHistory()
    }
  }, [restore, dropHistory])

  return {
    doc,
    seq: meta.seq,
    canUndo: meta.canUndo,
    canRedo: meta.canRedo,
    reset,
    transient,
    commit,
    undo,
    redo
  }
}
