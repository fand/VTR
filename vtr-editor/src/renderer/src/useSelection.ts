import { useCallback, useState } from 'react'
import type { PointSel } from './components/CurvePanel'
import type { Doc } from './history'

/**
 * The editor's selection: clips, tracks, curve points. The invariants live
 * here and nowhere else:
 *
 * - Clip and track selections are mutually exclusive.
 * - Selecting clips or tracks clears the point selection (a curve point
 *   only makes sense within the clip it belongs to); a point selection
 *   does NOT clear the clip selection — points are picked inside it.
 * - Additive select (shift/cmd-click) toggles membership.
 */
export function useSelection(): {
  clipIds: number[]
  trackIds: number[]
  points: PointSel[]
  /** Direct set (paste/duplicate/delete results); leaves the rest alone. */
  setClipIds: React.Dispatch<React.SetStateAction<number[]>>
  setPoints: React.Dispatch<React.SetStateAction<PointSel[]>>
  selectClip: (id: number | null, additive?: boolean) => void
  /** Marquee select: replaces the clip selection with the given set. */
  selectClips: (ids: number[]) => void
  selectTrack: (id: number, additive: boolean) => void
  /** Project switch: nothing from the old doc survives. */
  clearAll: () => void
  /** Undo/redo can reinstall ids from an earlier session; drop selections
   *  that no longer resolve in the restored doc. */
  pruneToDoc: (doc: Doc) => void
  trackDeleted: (trackId: number) => void
} {
  const [clipIds, setClipIds] = useState<number[]>([])
  const [trackIds, setTrackIds] = useState<number[]>([])
  const [points, setPoints] = useState<PointSel[]>([])

  const selectClip = useCallback((id: number | null, additive = false) => {
    setPoints([])
    setTrackIds([])
    if (id == null) {
      setClipIds([])
      return
    }
    setClipIds((ids) => {
      if (!additive) return [id]
      return ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]
    })
  }, [])

  const selectClips = useCallback((ids: number[]) => {
    setPoints([])
    setTrackIds([])
    setClipIds(ids)
  }, [])

  const selectTrack = useCallback((id: number, additive: boolean) => {
    setPoints([])
    setClipIds([])
    setTrackIds((ids) => {
      if (!additive) return [id]
      return ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]
    })
  }, [])

  const clearAll = useCallback(() => {
    setClipIds([])
    setTrackIds([])
    setPoints([])
  }, [])

  const pruneToDoc = useCallback((doc: Doc) => {
    setClipIds((ids) =>
      ids.filter((id) => doc.tracks.some((t) => t.clips.some((c) => c.id === id)))
    )
    setTrackIds((ids) => ids.filter((id) => doc.tracks.some((t) => t.id === id)))
    setPoints([])
  }, [])

  const trackDeleted = useCallback((trackId: number) => {
    setClipIds([])
    setTrackIds((ids) => ids.filter((id) => id !== trackId))
    setPoints([])
  }, [])

  return {
    clipIds,
    trackIds,
    points,
    setClipIds,
    setPoints,
    selectClip,
    selectClips,
    selectTrack,
    clearAll,
    pruneToDoc,
    trackDeleted
  }
}
