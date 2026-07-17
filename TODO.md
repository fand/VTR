# TODO

From full-app review (2026-07-17). Each task: Problem → Failure → Fix → Test.
Tasks marked **TDD** go red-green: write the failing test first, then fix.
File refs are `osc-editor/src/...` unless prefixed `osc-tap/`.

## High — data loss / corruption

### 1. Move undo log into the project bundle — decided: bundle, not userData

- Problem: `undo.jsonl` is one global file in userData (`main/undo.ts:11-13`), but the
  cursor `undoSeq` is stored per project in project.json (`shared/types.ts:120-123`).
  On boot, `App.tsx:309` splits the log at `project.undoSeq` into undo/redo stacks —
  it has no way to know which project wrote which entry.
- Failure: edit project B (log now holds B's patches), then open project A → boot
  splits B's log at A's `undoSeq`; Cmd+Z applies B's immer patches to A's doc.
  Generic paths like `tracks/0/clips/0/offset` apply without error → A is silently
  corrupted, and Cmd+S persists it. Second variant: untitled boot skips loading the
  log but appends from `nextSeq = 1` (`App.tsx:342`) → duplicate seq numbers in a
  log that still holds the previous project's entries.
- Fix (decided): store the log at `<bundle>.oscproj/undo.jsonl`. Untitled sessions
  stage it in userData and move it into the bundle on Save As — same
  staging-then-collect pattern as clips (`main/project.ts:100-119`). Main process
  needs a per-project undo path instead of the single `dataDir` path.
- Fold these related defects into the same change:
  - Renderer `undo.append`/`truncateAfter` are fire-and-forget with
    `.catch(() => {})` (`renderer/src/history.ts:91,96,115`) — on IPC/disk failure
    memory and disk silently diverge. Surface the error (banner) or retry.
  - Compaction keeps the last 1000 entries regardless of `undoSeq`
    (`main/undo.ts:39-45`) — after >2000 uncommitted-to-save commits, the entries
    bridging `undoSeq` → tail are gone and boot builds a redo stack whose first
    patch doesn't apply to the saved doc, undetected. Compact relative to
    `undoSeq`, or store a base-seq check and refuse to replay across a gap.
  - In-memory `past` caps at 1000 via `shift()` (`history.ts:95`) while disk holds
    2000 — `canUndo` reflects memory only. Align the two caps.
- Test (TDD): e2e red test first — edit project B, relaunch into project A, Cmd+Z,
  assert A unchanged. Plus unit tests for the log split/compaction logic once it
  takes a project identity.

### 2. **TDD** Fix tap control-socket reply matching

- Context: TapManager (main process) talks to osc-tap over a unix socket with
  newline-delimited JSON. Replies are matched to requests purely by FIFO order:
  `onData` does `this.pending.shift()` per line (`main/tap.ts:277`).
- Defect A (timeout skew): a timed-out request removes itself from `pending`
  (`tap.ts:229`) and rejects, but osc-tap still sends its reply later. That late
  line then `shift()`s the *next* pending request → every subsequent reply is off
  by one until the socket drops. Scenario: `status` times out at 3s while a `start`
  is pending; `start` resolves with the status payload (`r.clip` undefined).
- Defect B (connect race): `connect()` checks `this.sock` then awaits
  `tryConnect()` (`tap.ts:239-243`); two concurrent callers both pass the null
  check and open two sockets. Both attach `onData` to the SAME shared `buf` and
  `pending` (`tap.ts:255`); `this.sock` is overwritten, the first socket is never
  destroyed. Replies from two connections interleave into one FIFO → mismatched or
  mid-line-spliced responses, plus a leaked socket.
- Fix: (a) put an `id` on each request and have osc-tap echo it
  (`osc-tap/src/control.rs` change), match replies by id, ignore unknown ids —
  this kills both defects; or (b) protocol-unchanged alternative: strictly
  serialize requests (single in-flight, queue the rest) AND share one connect
  promise so only one socket can ever exist. Prefer (a); it also survives future
  concurrent use.
- Test (TDD): unit-test TapManager against a fake control server (`net.Server` on
  a temp socket path). Red tests: ① server delays reply past REQUEST_TIMEOUT_MS,
  then answers; next request must get ITS OWN reply, not the stale one. ② two
  concurrent requests during initial connect → exactly one socket accepted by the
  server. Keep e2e green (`e2e/ports-seek.spec.ts` etc. exercise the real tap).

### 3. Keep unreadable clips as missing instead of dropping them

- Context: `loadProject` wraps per-clip loading in try/catch and on ANY throw
  removes the clip from the track and only records its name in `missing[]`
  (`main/project.ts:55-67`). The doc the renderer gets — and later saves — no
  longer contains the clip reference. Cmd+S makes the removal permanent.
- What actually throws (all verified in code):
  - Torn last JSONL line: osc-tap appends line-by-line; crash/power-loss can leave
    a partial final line. `readClip` JSON.parses every line with no per-line guard
    (`main/clips.ts:21`) → one bad line throws the WHOLE clip away.
  - Corrupt `.edits.json` sidecar: parsed inside the same try
    (`project.ts:61`) → a broken sidecar kills the clip even when the clip file
    itself is perfectly fine.
  - File genuinely absent: user deleted it externally, or a crash hit between
    collectClips' move and the project.json write (see task 7).
  - Perms/disk errors.
- Fix, two steps:
  1. Make `readClip` lenient: skip unparseable lines (same policy as
     `main/undo.ts:24` uses for the undo log). Most corruption becomes non-fatal.
  2. For clips that still fail: KEEP the reference in the track with a
     `missing: true` / `summary: null` marker so save round-trips it; render it
     grayed out. Move sidecar parsing OUT of the clip try-block so a bad sidecar
     degrades to "no edits", not "no clip".
- Test (TDD): unit (vitest) — `readClip` on a file with a torn last line returns
  the intact events; `loadProject` with a corrupt sidecar keeps the clip. E2E —
  make a referenced clip unreadable, open, save, restore the file, reopen: clip is
  back.

### 4. Bundle the osc-tap binary in packaged builds

- Problem: `findTapBinary` looks at
  `join(app.getAppPath(), '../osc-tap/target/{release,debug}/osc-tap')`
  (`main/index.ts:63-66`). In a packaged app, `getAppPath()` is inside
  `Resources/app.asar`, so `../osc-tap/...` points inside `Resources/` where
  nothing exists, and `electron-builder.yml` has NO `extraResources` entry, so the
  Rust binary is never shipped. Every installed build throws at boot
  (`index.ts:68`) unless `OSC_TAP_BIN` is set → recording impossible, contradicting
  spec's packaged-launchd story.
- Fix: `extraResources` in electron-builder.yml copying
  `../osc-tap/target/release/osc-tap` to e.g. `Resources/bin/osc-tap`;
  `findTapBinary` checks `join(process.resourcesPath, 'bin/osc-tap')` first when
  `app.isPackaged`. NOTE: the launchd plist that TapManager writes embeds the
  binary path — it must point at the bundled binary, and a stale plist from a dev
  build must be rewritten, not reused.
- Test: hard to e2e cheaply; at minimum unit-test the candidate order for
  packaged vs dev (inject `isPackaged`/paths), and verify one real
  `npm run build:mac` manually.

### 5. CurvePanel does not scale to 120 Hz clips

- Problem, two independent causes:
  - Hover: every pointermove calls `setMouse` (`renderer/src/components/CurvePanel.tsx:698`),
    re-rendering the entire panel. Render cost is O(events): one `<circle>` per
    event, `stepPoints` polyline string rebuilt per curve, O(N) scans in
    `hoverInfo`/`selBox` (`CurvePanel.tsx:527-545, 411-432, 974-991`). A 5-min
    120 Hz clip ≈ 36k events → tens of thousands of SVG nodes reconciled per
    mousemove → multi-second jank.
  - Timeline drags: the `curves` memo depends on `clips`/`edits`
    (`CurvePanel.tsx:268-274`), and every drag transient replaces the doc, so
    `buildProperties` (full pass + sort over ALL loaded events) re-runs per
    pointermove even when the drag doesn't touch the selected clip's events.
- Step 1 (do FIRST — cheap, orthogonal, then measure):
  - Take mouse/hover state out of React render: track it in a ref and paint the
    hover indicator in a small overlay component (or rAF-driven imperative
    update), so pointermove never re-renders the point cloud.
  - Keep the `curves` memo alive during transients: memo on the actual inputs
    (clip file list, per-clip event arrays, edits) rather than doc identity —
    drag transients change clip placement, not event data.
- Step 2 (decided: hybrid canvas):
  - Draw curve lines + ALL points on a `<canvas>` (devicePixelRatio-aware).
  - Keep a thin SVG/DOM overlay ONLY for interactive elements: selected-point
    handles, hovered point, marquee rect, tooltip. These stay e2e-testable.
  - Hit-testing (pointer → event index) becomes pure functions over the event
    arrays → unit-test with vitest.
  - E2E impact: specs that count nodes (`e2e/curve.spec.ts:63-66` asserts
    `polyline`/`circle` counts) must be rewritten against overlay elements or
    test hooks; handle-interaction specs survive.
- REJECTED: SVG point virtualization (culling + decimation). Reasons, so nobody
  re-proposes it: (a) when zoomed out the whole clip is in-viewport, so culling
  removes nothing — you must decimate (min/max per pixel bin); (b) decimation
  breaks the invariant "one visible `<circle>` = one real event", so click/
  marquee/drag selection needs a data-side coordinate lookup anyway — the exact
  hit-testing you'd write for canvas, paid twice; (c) even decimated, mid-zoom
  levels keep thousands of live nodes and pan/zoom churns node creation per
  frame — SVG's practical ceiling (~5-10k nodes) stays close, canvas is
  effectively unbounded. Only advantage was e2e compatibility, which the hybrid's
  DOM overlay mostly preserves.

## Medium

### 6. Unsaved-changes prompt on quit

- Problem: no `close`/`before-quit` interception (`main/index.ts:306-312`) and no
  autosave (removed earlier; `e2e/app.spec.ts:67` documents that). Cmd+Q discards
  all unsaved timeline state without asking. The crash-recovery tail (undo log
  entries past `undoSeq`) only replays when the SAME project is reopened by CLI
  arg, so it is not a safety net for normal quit.
- Fix: track dirty state (renderer already knows edited-state for the proxy icon —
  `setDocumentEdited`), intercept window close / `before-quit`, show
  save/discard/cancel dialog. Keep e2e in mind: dialogs must be stubbable like the
  existing shell-error stubs.

### 7. **TDD** Make save transactional

- Window A: the `project:save` IPC handler runs `collectClips` (which MOVES staged
  recordings — rename, source deleted) BEFORE `saveProject` writes project.json
  (`main/index.ts:240-242`). Crash between the two → the untitled session's
  recordings now sit inside a bundle whose project.json doesn't exist (or doesn't
  reference them); untitled resolution (staging dir) can't find them → "missing
  clip" with the data stranded on disk.
- Window B: `saveProject` writes edit sidecars, then `rmSync`s stale sidecars,
  then writes project.json LAST (`main/project.ts:121-140`). Crash after the
  rmSync → the old project.json survives but a sidecar it depends on is gone.
  Also `editsPath` for a clip resolving into a nonexistent `clips/` dir makes
  `writeFileSync` throw ENOENT mid-loop → save aborts half-done
  (`project.ts:126-129`).
- Related hazard: a recording started while a project is open writes into
  `projectDir/clips` captured at START time (`main/index.ts:192-194`); Save As
  during recording switches projectDir → the finished clip lands in the OLD
  bundle while the new project.json references it by name only.
- Fix: reorder to additive-first — ① copy (not move) staged clips + write new
  sidecars, ② write project.json (atomic rename), ③ only then delete staged
  sources and stale sidecars; deletions after commit are safe to lose. Guard the
  ENOENT case with `mkdirSync(recursive)`. Harden `writeAtomic`
  (`project.ts:30-34`): fsync before rename, unique tmp suffix (fixed `.tmp` name
  is a two-instance clobber; see task 17).
- Test (TDD): unit — inject a throw between each step (wrap fs ops), assert the
  on-disk state is either fully-old or fully-new and staged sources still exist
  until commit. E2E — untitled record → Save As → relaunch → clips resolve.

### 8. **TDD** Block undo/redo during an active gesture

- Problem: `undo`/`redo` apply inverse patches to `docRef.current`
  (`renderer/src/history.ts:119-141`), but during a drag `docRef.current` is the
  TRANSIENT doc (gesture base is pinned separately). Cmd+Z mid-drag applies
  patches on top of uncommitted transient mutations: either a silently wrong doc,
  or `applyPatches` throws and the catch calls `dropHistory()` — wiping the ENTIRE
  undo stack (`history.ts:112-117` divergence path).
- Fix: make undo/redo no-ops while a transient is active (the history hook knows —
  base is pinned). Simple and predictable; do NOT try to auto-commit the gesture.
- Test (TDD): red e2e — start a clip drag, press Cmd+Z while the pointer is down,
  release; assert doc equals plain-drag result and undo stack is intact (one more
  Cmd+Z reverts the drag). If the transient logic gets extracted, add a vitest for
  the guard.

### 9. **TDD** Validate renderer-supplied paths in IPC; shrink preload surface

- Problem: main-process handlers trust raw renderer strings:
  - `clip:events` calls `readClip(path)` on any absolute path (`main/index.ts:195-197`)
    → arbitrary-file read (JSONL-shaped).
  - `tap:stop` runs `clipSummary(clipPath)` on any path (`index.ts:211-217`).
  - `project:save` does `mkdirSync` + writes to ANY path (`index.ts:235-243`) →
    arbitrary directory/file creation.
  - `mergeProject` resolves `clip.file` via `join(projectDir, 'clips', file)` with
    no check — `../../…` escapes the bundle (`main/merge.ts`).
  - Preload exposes `@electron-toolkit/preload`'s `electronAPI`, which includes a
    GENERIC `ipcRenderer` (invoke/send/on any channel) alongside the typed `api`
    (`preload/index.ts:76`), and windows run `sandbox: false` (`index.ts:91`) — so
    any injected script reaches all of the above without the typed wrapper.
- Risk framing: local single-user tool, so this is hardening, not an emergency —
  but `project:save` writing to arbitrary paths is the one to close first.
- Fix: a `validatePath(root, p)` helper (resolve + prefix check, reject `..`);
  restrict clip/summary reads to project dir + staging dir, saves to
  user-dialog-obtained paths (main already owns the dialog); reject traversal in
  `clip.file` at load AND merge time. Stop exposing `electronAPI`; export only the
  typed `api` (keep `process.versions` if the About box needs it).
- Test (TDD): vitest on `validatePath` (rejects `../x`, absolute escapes, symlink
  parent tricks not required); unit tests invoking the handler functions directly
  with hostile paths, asserting rejection and no fs effect.

### 10. Remove the launchd plist on quit

- Problem: packaged-mode shutdown runs `launchctl bootout` but leaves the plist
  (with `RunAtLoad=true`) in `~/Library/LaunchAgents`
  (`main/tap.ts:131-140, 187-195`). Next login: launchd bootstraps osc-tap with no
  editor running; it binds ports 10010/10012 forever (relative of the known UDP
  port-orphan gotcha) and blocks other apps.
- Fix: delete the plist during shutdown after bootout (and on startup, rewrite a
  stale plist so the binary path is always current — ties into task 4). Intentional
  restart within 2s also trips the crash-loop backoff (`tap.ts:76,117-119`) —
  reset `respawnDelay` on explicit restart while here.
- Test: extend `e2e/launchd.spec.ts` (RUN_LAUNCHD=1): after app quit, assert plist
  absent and agent not loaded.

### 11. **TDD** Preview UDP socket error handling

- Problem: `main/preview.ts:14` creates the dgram socket with NO `'error'`
  listener, and `send()` is called without a callback (`preview.ts:58`); the
  surrounding try/catch only catches sync throws. An async send error (e.g.
  ECONNREFUSED surfaced via ICMP on a connected-refused port) is emitted as an
  unhandled `'error'` event → crashes the whole main process mid-preview.
- Fix: attach an `'error'` handler (log + notify renderer banner, stop preview
  cleanly), pass a send callback that counts/reports failures.
- Test (TDD): unit — construct the preview module with an injected socket (or
  emit `'error'` on its socket), assert no throw and the stop/notify path runs.

### 12. Handle Finder open of `.oscproj`

- Problem: electron-builder declares the `.oscproj` file association
  (`electron-builder.yml:14-19`) but there is no `app.on('open-file')` handler and
  no second-instance handling; only terminal `argv` parsing exists
  (`main/index.ts:43-44`). Double-click in Finder launches (or focuses) the app
  with an empty project.
- Fix: register `app.on('open-file')` BEFORE `ready` (cache the path, load after
  ready); if the app is already running, load the project (prompt if dirty — task
  6). Do together with single-instance lock (task 17) so a second launch forwards
  its argv.

### 13. **TDD** Cap timeline duration / ruler marks

- Problem: the ruler loop iterates `0..end` by `step` with no cap on mark count,
  and `widthPx = end * pxPerSec` feeds a DOM width (`renderer/src/components/Timeline.tsx:517-526`).
  The `dur` field accepts any positive number — `parseDuration` (`renderer/src/expr.ts`)
  only checks `> 0`. Typing `99999999` at default zoom → ~20M loop iterations and
  a div width beyond browser layout limits → renderer freeze.
- Fix: clamp committed duration to a sane max (e.g. 86400 s) at the commit point,
  AND generate ruler marks only for the visible scroll range (cheap: derive
  first/last visible mark from scrollLeft/viewport width).
- Test (TDD): vitest — duration commit clamps huge/`Infinity`-ish values; e2e —
  type a huge dur, app stays responsive, field shows the clamp.

### 14. osc-tap: staleness cutoff for beacon `tl` stamping

- Problem: `tl` is extrapolated from the last `/clock` beacon
  (`osc-tap/src/tap.rs:36, 259`) with NO age cutoff. `beacon_age` is computed for
  `status` but the writer never consults it. If TD quits mid-recording (rate
  stays 1.0), every later event still gets a `tl` advancing from a beacon minutes
  old — plausible-looking but wrong values that later poison the editor's
  auto-align (median tl−t in `main/clips.ts:28-32`).
- Fix: if beacon age > cutoff (a few seconds; rate==0 freeze case stays valid —
  that's an intentional pause, distinguish by age not rate), omit `tl` per the
  spec's "omit when unknown" contract. Also: NaN `t` in `/clock` currently yields
  `"tl":null` via serde (`tap.rs:385-387` same mechanism) — reject non-finite
  beacon values explicitly.
- Test (Rust, `osc-tap/tests/e2e.rs` style): send `/clock`, wait past cutoff, send
  an event → no `tl` field. Existing rate-zero freeze test must stay green.

### 15. osc-tap: surface write failures in status

- Problem: `write_line` failures only `eprintln!` and recording continues as if
  healthy (`osc-tap/src/tap.rs:359-368`); `Status` has no error field. Disk full
  mid-performance → `status` still says `recording: true` with a frozen event
  count; the operator learns after the show that the clip is truncated.
- Fix: latch a `write_error: Option<String>` (+ count) in writer state, expose in
  the `status` reply; editor polls status already — show a persistent red banner.
  While here: reset the process-lifetime `dropped` counter per clip start
  (`tap.rs:320`) so the editor can attribute drops to the CURRENT recording.
- Test (Rust): start recording into a read-only dir (or close the file handle via
  test hook), send events, assert `status` carries the error.

### 16. Check project.json version on load

- Problem: `version: 1` is written but never read — `loadProject` blind-casts
  `JSON.parse` (`main/project.ts:50`). A future v2 file, or a hand-edited file
  with `tracks` in the wrong shape, either explodes deep in the renderer or
  silently misloads. The undo log has no version/project stamp either (covered by
  task 1's redesign).
- Fix: validate `version === 1` (clear error dialog otherwise) plus a minimal
  shape check (tracks is array, clips have string `file`). Keep it cheap — no
  schema library needed.

### 17. Single-instance lock

- Problem: no `app.requestSingleInstanceLock()`. Two instances share one
  userData: both append to the same undo.jsonl (`main/undo.ts:41`), both use the
  same control socket path (`main/tap.ts:57`) — and osc-tap's stale-socket cleanup
  unlinks any existing socket without a liveness probe
  (`osc-tap/src/control.rs:17-19`), so the second tap STEALS the first's control
  plane. Same staging dir, same fixed `.tmp` names (task 7).
- Fix: `requestSingleInstanceLock()`; second instance forwards its argv (project
  path) to the first via `second-instance` event (pairs with task 12) and quits.

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

- [ ] Add a vitest unit layer — `osc-editor/package.json` has no unit runner; 17
  Playwright specs are the only tests and they exercise pure functions
  indirectly. First targets (all currently untested):
  - `mergeProject` trim boundaries: a `t`-edit that moves an event across
    trimIn/trimOut; edits on `add`ed events (`shared/edits.ts` `applyEditsIndexed`
    set/del-on-add paths).
  - `editsEmpty`, `resolveClipPath` precedence (bundle clips/ → legacy flat →
    staging → fallback-to-first).
  - New code from tasks above: lenient `readClip`, `validatePath`, duration
    clamp, canvas hit-testing.
- [ ] E2E gaps (each is a designed-for scenario with zero coverage):
  - Redo after relaunch — log entries with seq > `undoSeq` become the redo stack
    (crash-recovery path). Planned in `docs/tasks/persistency/plan.md:153`, never
    written. `e2e/undo.spec.ts` covers only undo-after-restart and truncation.
  - Cross-project undo contamination (task 1's red test).
  - Missing/corrupt clip → open → save keeps the reference (task 3's red test).
  - Untitled → record → Save As collects staged clips by MOVE — only the
    with-project copy path is tested (`e2e/bundle.spec.ts`); the EXDEV
    copy-fallback in `transfer` (`main/project.ts:82-93`) is fully untested.
  - Undo-log compaction past 2000 entries (task 1).
  - Torn undo.jsonl tail (crash mid-append → parse-drop at `main/undo.ts:24`).
  - `applyPatches` divergence → `dropHistory` (`history.ts:112-117`) — currently
    unobservable to users when it fires; assert a banner once task 1 adds one.
  - Multi-instance launch (task 17), save-dialog cancel, export write failure.
