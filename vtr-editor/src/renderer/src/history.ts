import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer'
import { useCallback, useRef, useState } from 'react'
import { UNDO_CAP, type ClipEdits, type UndoEntry } from '../../shared/types'
import type { MarkerState, TrackState } from './timeline/model'

enablePatches()

/** Everything undoable. Ports (device config) and view state stay outside. */
export interface Doc {
  tracks: TrackState[]
  markers: MarkerState[]
  duration: number
  edits: Record<string, ClipEdits>
}

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
  /** Cancelled gesture (pointercancel): drop transient state, restore the base. */
  abortTransient: () => void
  undo: () => void
  redo: () => void
}

export function useHistory(
  initial: Doc,
  onRestore: (doc: Doc) => void,
  onError: (message: string) => void,
  /** Fires when an entry is recorded, undone, or redone; labels feed the status bar log. */
  onLog?: (kind: 'commit' | 'undo' | 'redo', label: string) => void
): History {
  const [doc, setDoc] = useState(initial)
  const docRef = useRef(doc)
  const base = useRef<Doc | null>(null)
  const past = useRef<UndoEntry[]>([])
  const future = useRef<UndoEntry[]>([])
  const nextSeq = useRef(1)
  // Stacks live in refs; render-facing facts about them live in state.
  const [meta, setMeta] = useState({ seq: 0, canUndo: false, canRedo: false })

  // In-memory history works either way, but undo won't survive a restart.
  const persistError = useCallback(
    (e: Error): void => onError(`failed to write undo log: ${e.message}`),
    [onError]
  )

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
      // The disk log can briefly hold more than the cap; undo depth can't.
      past.current = p.slice(-UNDO_CAP)
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
        window.api.undo.truncateAfter(top?.seq ?? 0).catch(persistError)
      }
      const entry: UndoEntry = { seq: nextSeq.current++, label, patches, inversePatches }
      past.current.push(entry)
      if (past.current.length > UNDO_CAP) past.current.shift()
      window.api.undo.append(entry).catch(persistError)
      install(next)
      onLog?.('commit', label)
    },
    [install, persistError, onLog]
  )

  const abortTransient = useCallback((): void => {
    if (!base.current) return
    const b = base.current
    base.current = null
    install(b)
  }, [install])

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
    window.api.undo.truncateAfter(0).catch(persistError)
    install(docRef.current)
    // Losing the whole stack must not be silent.
    onError('undo history no longer matches the project; history cleared')
  }, [install, persistError, onError])

  const undo = useCallback((): void => {
    // Mid-gesture undo would apply patches onto the uncommitted transient
    // doc (or diverge and wipe the stack); ignore it until the gesture ends.
    if (base.current) return
    const entry = past.current.pop()
    if (!entry) return
    try {
      const next = applyPatches(docRef.current, entry.inversePatches)
      future.current.unshift(entry)
      restore(next)
      onLog?.('undo', entry.label)
    } catch {
      dropHistory()
    }
  }, [restore, dropHistory, onLog])

  const redo = useCallback((): void => {
    if (base.current) return
    const entry = future.current.shift()
    if (!entry) return
    try {
      const next = applyPatches(docRef.current, entry.patches)
      past.current.push(entry)
      restore(next)
      onLog?.('redo', entry.label)
    } catch {
      dropHistory()
    }
  }, [restore, dropHistory, onLog])

  return {
    doc,
    seq: meta.seq,
    canUndo: meta.canUndo,
    canRedo: meta.canRedo,
    reset,
    transient,
    commit,
    abortTransient,
    undo,
    redo
  }
}
