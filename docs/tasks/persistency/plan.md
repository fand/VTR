# Curve panel + non-destructive edits + persistent undo

Status: done. Landed as b249688 (edits pipeline), e6157c3 (curve panel),
aea13ef (point editing), b800678 (persistent undo/redo).

## Goals

- Curve panel under the tracks: per-address value curves for the selected clip.
- Edit data points (move in time/value, delete) without touching the recorded JSONL.
- Undo/redo for all content edits, surviving app restart. Linear history.

## Data model

### ClipEdits (non-destructive overlay)

Clip JSONL files stay immutable. Edits are a sparse overlay keyed by the event's
index in the original file (index into `readClip().events`; deletes don't shift keys).

```ts
// shared/types.ts
interface ClipEdits {
  /** eventIndex → partial patch. args is argIndex → new numeric value. */
  set?: Record<number, { t?: number; args?: Record<number, number> }>
  /** eventIndex → deleted. Wins over set. */
  del?: Record<number, true>
}
```

- `del` is a map, not an array: immer patches stay per-key.
- Edits are **per clip file**, not per placement. Two placements of one file share
  edits. (Divergent copies = future "duplicate clip file" feature.)
- Applying edits can reorder events (t changed) → re-sort by t after apply.

### applyEdits (shared)

`shared/edits.ts`: `applyEdits(events: OscEvent[], edits?: ClipEdits): OscEvent[]`
— apply `set`, drop `del`, re-sort by t. Used in exactly two places:

- main: `mergeProject` (the single choke point for export AND preview), applied
  **before** the trim filter so t edits affect trim inclusion.
- renderer: CurvePanel display.

### Persistence layout (workdir)

- `project.json` — as today + `undoSeq` (see below). No edits inline (stays small).
- `<clip>.jsonl` — immutable recording.
- `<clip>.edits.json` — sidecar, written only when edits exist (deleted when empty).
  Written via tmp+rename like session export.
- `undo.jsonl` — append-only history log.

IPC payloads (`session:export`, `preview:play`, `project:save`) carry edits
**inline** as `ProjectFile.edits?: Record<file, ClipEdits>` — autosave is debounced
400ms, so main must never read sidecars for preview/export (stale). `saveProject`
splits inline edits out to sidecars; `loadProject` reads them back.

## Undo architecture (immer + log + version)

### Renderer: single doc + history module

Undoable doc = `{ tracks: TrackState[], duration: number, edits: Record<file, ClipEdits> }`.
Excluded: ports (device config), selection/zoom/playhead (view state).

`history.ts` (renderer, immer `enablePatches()`):

- `commit(label, recipe)` → `produceWithPatches(base, recipe)` → new doc +
  append `{ seq, label, patches, inversePatches }` to `undo.jsonl` (IPC).
- `transient(next)` → set doc without recording; remembers `base` (the doc before
  the first transient change). The following `commit` produces patches **from
  base**, so a whole drag = one history entry. Used by: clip drag (Timeline
  already recomputes from `drag.orig` each move), curve point drag, duration
  NumField drag (today it commits on every pointermove — must switch to
  transient-then-commit on release).
- `undo()` / `redo()` → `applyPatches` with inversePatches / patches, move cursor.
- New commit while cursor < end → truncate log after cursor (linear history).
- Patch granularity: clip/track ops replace `doc.tracks` wholesale (few KB —
  fine); point edits patch `doc.edits[file].set[i]` per-key (the map that can
  grow large — never replaced wholesale).
- After undo/redo: `nextId = max(all ids) + 1`; clear selection if the selected
  clip no longer exists.
- Cap: keep last 1000 entries; rewrite the log when it exceeds 2× cap.

### Restart handling: `undoSeq` is the cursor

`project.json` gets `undoSeq: number` = seq of the doc state at save time.
No separate cursor file, no quit flush needed:

- Boot: load project + sidecars → doc. Read `undo.jsonl`:
  entries `seq ≤ undoSeq` → past stack; `seq > undoSeq` → future stack (redo).
- Crash after commit but before autosave: saved state is version n, log has
  n+1 → boots as a redo entry. Correct (entry n+1 applies to state n) and doubles
  as crash recovery.
- Torn last line (crash mid-append): drop it on parse.
- `applyPatches` failure (state/log divergence, e.g. hand-edited files): drop the
  whole history, keep current state. Undo is best-effort.

### Main-side IPC

- `clip:events(path)` → raw `OscEvent[]` (renderer applies edits itself so the
  curve updates without IPC roundtrip per keystroke). Renderer caches by path
  (files are immutable).
- `undo:load()` → entries; `undo:append(entry)`; `undo:truncateAfter(seq)`.

### Cmd+Z vs the default Electron menu

No `Menu.setApplicationMenu` in main → macOS gets the default menu, whose
Edit ▸ Undo/Redo roles **swallow Cmd+Z / Shift+Cmd+Z before the page sees the
keydown**. Fix: set a custom menu where Undo/Redo are plain items sending
`menu:undo` / `menu:redo` over IPC. Renderer handler: if a text input is
focused → `document.execCommand('undo')` (keep native field undo), else
`history.undo()`. Keep the other default roles (copy/paste/quit/etc).

## UI: CurvePanel

Between the timeline and the tl-toolbar, ~220px, two columns.

- **Left: property list.** One row per (address, argIndex) with a numeric arg in
  the selected clip. Single-arg addresses show `/fader1`; multi-arg show `/xy[0]`,
  `/xy[1]`. Color swatch + visibility toggle (checkbox/eye). Visibility is
  renderer-session state, not persisted. Non-numeric args are not listed.
- **Right: curve editor (SVG).** X = clip-local time fit to the trim range;
  Y = per-property min/max auto-scale (padded). Lines + circles at data points.
  Nothing selected → placeholder text.
- **Point interaction:** click selects a point; drag moves it (horizontal = t,
  clamped to [trimIn, trimOut]; vertical = value). Transient while dragging,
  one commit on release. Delete/Backspace deletes the selected point.
  Edits write `doc.edits[file]`.
- **Point selection lives in App state** (`selectedPoint: {file, eventIndex} | null`),
  not inside CurvePanel: a selected point always implies a selected clip, and
  both Delete handlers listen on window — with local state the key would delete
  the point AND the clip (`stopPropagation` doesn't help between two window
  listeners). One handler in App: point selected → delete point; else clip
  selected → delete clip. Selecting a different clip clears the point.

## Steps (one commit each)

1. **Edits pipeline (no UI).** `ClipEdits` type, `shared/edits.ts`,
   sidecar save/load in `project.ts`, inline edits in ProjectFile payloads,
   `mergeProject` applies before trim, `clip:events` IPC.
   e2e: write a sidecar by hand → export reflects changed/deleted values.
2. **CurvePanel, read-only.** Layout, property list, colors, visibility toggles,
   SVG curves from `clip:events` + applyEdits. e2e: record multi-address clip →
   select → list shows addresses → toggle hides a polyline.
3. **Point editing.** Select/drag/delete points → edits overlay (plain setState;
   history funnel arrives in step 4). e2e: drag a point → export + sidecar show
   the new value; delete → event count drops.
4. **Persistent undo/redo.** Add `immer` (new dep, ~14KB, no native code, no CSP
   impact). history.ts, doc refactor in App (tracks/duration/edits → one state),
   undo.jsonl + undoSeq, custom Edit menu (see above).
   Commit sites (everything else is transient or view state):
   - record stop (clip added), Align, clip drag/trim release, clip delete,
     track add/delete, duration commit, point move release, point delete.
   e2e: move clip → undo → position restored; relaunch → undo still works;
   redo after relaunch; new edit after undo truncates redo.

## Non-goals / future

- Compaction (bake overlay into a `.v2.jsonl` when edits exceed ~50% of events).
- Undo tree, per-placement edits, inserting new points, bulk ops (smooth/scale).
- Persisting curve visibility per project.
