# TODO

From full-app review (2026-07-17). Each task: Problem → Failure → Fix → Test.
Tasks marked **TDD** go red-green: write the failing test first, then fix.
File refs are `osc-editor/src/...` unless prefixed `osc-tap/`.

## Low

- [ ] Clear clip clipboard on project open (`App.tsx:595-607`) — `clipClipboard`
  and `canPaste` survive `applyLoaded`; pasting after File>Open inserts a clip
  whose `file`/`path` point into the PREVIOUS bundle → missing at preview/export.
  Reset both in `applyLoaded`.
- [ ] CurvePanel `eventsCache`: don't cache failures (`CurvePanel.tsx:252-260`) —
  a failed `clip.events` IPC is cached as `[]` in a module-level Map that is never
  evicted → one transient read error (e.g. file mid-move during save) blanks that
  clip's curves for the whole session; cache also grows across projects. Skip
  caching on error; clear (or key by project) on project switch.
- [ ] Handle `pointercancel` in all drag gestures — none exists anywhere. A
  cancelled drag (OS gesture, window losing pointer) leaves `drag.current` set and
  the transient uncommitted: clip drag (`Timeline.tsx:478-486`), marker drag,
  NumField scrub (`App.tsx:114-148`), panel splitter (`App.tsx:1181-1194`). Treat
  `pointercancel` exactly like `pointerup` (commit or explicitly abort transient).
- [ ] Marker drag must clamp seek (`Timeline.tsx:488-499`) — `applyMarkerDrag`
  calls raw `onSeek(time)`, bypassing `clampSeek`, and marker time is only
  clamped at 0; dragging a marker past the end pushes the playhead beyond `end`
  (undoes the intent of commit ccaf118). Clamp both marker time and seek to
  `[0, end]`.
- [ ] In-flight guard for `togglePlay` (`App.tsx:861-877`) — `busy` covers only
  recording; two fast Space presses both see `playing === null` and both call
  `preview.play`; the second `setPlaying` wins with a `startedAt` that doesn't
  match what main streams → skewed playhead. Guard until the promise settles.
- [ ] Preview OSC re-encode is lossy (`main/osc.ts:23-42`) — root cause: recorded
  JSONL has no OSC type tags, so re-encoding guesses. Non-integer numbers and
  ints > 2^31 become f32 (`d` precision lost); a genuine STRING equal to
  `"<impulse>"` or matching `#rrggbbaa` is re-encoded as impulse/color. Affects
  preview only (export copies JSONL unchanged). Proper fix = record type tags in
  osc-tap's JSONL and use them; otherwise document the ambiguity. Low priority.
- [ ] osc-tap small fixes: warn (or accept Int) when `/clock` arg is not
  Float/Double (`osc-tap/src/tap.rs:425-431` — currently silently ignored, all
  clips just lack `tl` with no hint); rate-limit forward-send/recv error logging
  (`tap.rs:143-157` — TD down → ~120 log lines/s); note backlog cap bounds count
  not bytes (`tap.rs:22,153-157`, worst case ~4 GB — fine for trusted LAN, don't
  "fix" without need).
- [ ] electron-builder cleanup — `appId: com.electron.app` is a template leftover
  and mismatches the `com.osc-mtr.editor` AppUserModelId (breaks Windows taskbar
  grouping); `publish.url: https://example.com/auto-updates` is a dead
  placeholder. Set appId to `com.osc-mtr.editor`; drop `publish` until an updater
  exists. NOTE: changing appId changes userData path on some platforms — check
  before shipping, migrate staging/undo if needed.
- [ ] `git rm --cached osc-editor/test-results/.last-run.json` — committed before
  the ignore rule; only tracked stray. The other jsonl/sock litter in
  `osc-editor/` is untracked dev-run leftovers, ignored by root `.gitignore:3-9`
  (but note: those ignore rules would also HIDE a regression that writes to cwd
  again).

## Tests

- [ ] Grow the vitest unit layer (runner exists: `npm run test:unit`; covers
  undo.ts only). Next targets (all currently untested):
  - `mergeProject` trim boundaries: a `t`-edit that moves an event across
    trimIn/trimOut; edits on `add`ed events (`shared/edits.ts` `applyEditsIndexed`
    set/del-on-add paths).
  - `editsEmpty`, `resolveClipPath` precedence (bundle clips/ → legacy flat →
    staging → fallback-to-first).
- [ ] E2E gaps (each is a designed-for scenario with zero coverage):
  - Redo after relaunch — log entries with seq > `undoSeq` become the redo stack
    (crash-recovery path). Planned in `docs/tasks/persistency/plan.md:153`, never
    written. `e2e/undo.spec.ts` covers undo-after-restart, truncation, and
    cross-project isolation.
  - `applyPatches` divergence → `dropHistory` — now surfaces in the error
    banner; assert it in e2e.
  - Save-dialog cancel, export write failure.
