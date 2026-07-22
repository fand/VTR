# Plan: OSC record control

Status: done. Spec: [spec.md](spec.md).

## Shape

1. vtr-tap: event log + `wait` cmd; `/rec/start` / `/rec/stop` on the
   beacon port; `tl` in `session_start`; `rec_t` + `last_clip` in status.
2. editor: wait loop in TapManager, event-driven recording state in the
   renderer; the 1s poll becomes display-only.
3. e2e both sides.
4. docs.

## Steps

### 1. vtr-tap: event log (`vtr-tap/src/tap.rs`)

- `Event` enum: `RecStarted { clip, tl: Option<f64> }`,
  `RecStopped { clip }`. Serializes as `{"ev":"rec_started",...}`.
- `EventLog`: ring buffer (cap 64) of `(seq, Event)`, seq starts at 1 and
  only grows. `Arc<(Mutex<EventLog>, Condvar)>`; `push` notifies waiters.
  `wait_since(n, timeout) -> WaitResult { seq, events, reset }`. With
  buffered seqs `oldest..newest`, serving needs `n >= oldest-1`; `reset`
  when `n < oldest-1` (overflow) or `n > newest` (tap restarted). seq is
  only meaningful within one process — the editor re-baselines on every
  connect (step 4), so this reset is a backstop, not the primary detection.
- Writer pushes events inside `Msg::Start` / `Msg::Stop` handling — local
  and remote share those paths, so both emit events for free.
- `Status` gains `rec_t: Option<f64>` (`r.epoch.elapsed()`) and
  `last_clip: Option<PathBuf>` (set on stop).
- Unit tests drive `EventLog` directly: seq growth, overflow → reset,
  wait_since cutoff.

### 2. vtr-tap: `/rec` on the beacon thread (`vtr-tap/src/tap.rs`)

- Beacon thread gets a `Handle` (clone `tx` before spawn).
- In the flatten loop, match on address:
  - `/clock` → unchanged.
  - `/rec/start`: parse optional `tl`, `rate` via `arg_as_f64`. Finite `tl`
    → set beacon (`rate` default 1.0) **before** `handle.start_clip(None)`.
  - `/rec/stop` → `handle.stop_clip()`.
- `Err("already recording")` / `Err("not recording")` → rate-limited log,
  no error (idempotency). Log real start/stops to stderr.
- `Msg::Start`: compute `tl` (same age filter as packet stamping) → into
  the `session_start` header and the `RecStarted` event.

### 3. vtr-tap: `wait` cmd (`vtr-tap/src/control.rs`)

- `{"cmd":"wait","since":N}` → `EventLog::wait_since(N, SERVER_TIMEOUT)`;
  reply `{"ok":true,"seq":M,"events":[...]}`, plus `"reset":true` and
  `"status":<snapshot>` on reset. Empty `events` on timeout (client just
  re-issues). Server timeout ~25s, under the client's 30s.
- `since` omitted/null = baseline request: reply immediately with
  `reset:true`, the snapshot, and the current seq — no events. The editor
  uses this on every connect.
- Reply assembly order matters (baseline and reset paths): read the
  current seq BEFORE taking the status snapshot. An event landing between
  the two reads is then > the returned seq and gets delivered; the
  snapshot may just be newer than the seq, so editor handlers must
  tolerate an event that re-states what the snapshot already applied
  (step 5). The reverse order swallows transitions: snapshot says idle,
  then rec_started fires, then seq is read — that event is ≤ the returned
  seq and is never delivered.
- Blocking inside `serve_conn` would stall other id-multiplexed requests on
  the same connection. Fix: wrap the connection writer in `Arc<Mutex<_>>`;
  dispatch `wait` on its own thread which writes the reply when done.
  Out-of-order replies are fine — the editor already matches by id.
- `serve_conn` becomes generic over `Read + Write + Send` streams
  (Windows-proofing per spec); the listener loop stays unix-specific.

### 4. editor main: wait loop + IPC

- `shared/types.ts`: `TapStatus` + `rec_t`, `last_clip`; new `TapEvent`
  union (`rec_started`, `rec_stopped`) and wait-reply type.
- `TapManager`: `runEventLoop(onEvent, onReset)` — on every connect
  (first and each reconnect) start with a baseline `wait` (no `since`):
  apply the snapshot, adopt the returned seq, then loop
  `request('wait', { since }, 30s timeout)`; on reply dispatch events,
  update `since`, re-issue. Never carry `since` across connections — seq
  is per-process; a restarted tap could otherwise replay old events (a
  fresh editor at `since=0` would import every buffered clip again) or
  serve another epoch's seqs as if they continued the old one. `request()`
  gains a per-call timeout param.
- Re-baselining discards events from the disconnect gap; that is lossless
  today because the unix socket lives and dies with the tap process — a
  disconnect means the old EventLog is gone anyway, so there are no gap
  events to lose, and the new tap's snapshot (`recording`, `last_clip`)
  carries everything that happened before reconnect. On a future TCP
  transport a connection can drop while the tap lives; a gap holding more
  than one stop then auto-imports only `last_clip` (earlier clips stay on
  disk, importable by hand). If that ever matters, add a process epoch to
  wait replies and carry `since`+epoch across reconnects — an addition,
  not a rewrite.
- The loop retries forever with backoff. The existing `connectWithRetry`
  gives up after its 5s deadline — a tap down longer than that must pause
  the loop, not kill it.
- `main/index.ts`: start the loop, forward events AND baseline/reset
  snapshots via `webContents.send('tap:event', ...)` — snapshot-apply
  lives in the renderer, so resets must reach it too; new `clip:summary`
  handler →
  `clipSummary(ensureWithin(clipRoots(), path))` (staging is in
  `clipRoots()`). `tap:stop` loses its `clipPath` arg and summary return —
  import moves to the event path (update handler, preload, App call).
  Preload: `tap.onEvent`, `clips.summary`.

### 5. renderer: event-driven recording state (`App.tsx`)

- Poll keeps only display duties (status bar, write_error banner); all
  transition inference is deleted.
- Event handlers:
  - `rec_started` → `setRecording({ path, startedAt: performance.now() })`.
  - `rec_stopped` → `importClip(path)` (clip:summary → commit track),
    `setRecording(null)`.
  - Handlers must be idempotent — after a baseline/reset, an event can
    re-state what the snapshot already applied (step 3 read order):
    `rec_started` for the already-current path keeps `startedAt` (don't
    reset the timecode); `rec_stopped` re-import is guarded by the
    imported set.
- Snapshot apply (every connect / reset), one function:
  - recording → adopt with `startedAt = now - rec_t * 1000`.
  - not recording → `setRecording(null)` (tap crashed mid-clip: the stale
    REC state must clear).
  - `last_clip` set and no track references it and not in this session's
    imported set → import. Reference check compares `clip.file` (basename),
    not path — save collects staging clips into the bundle and deletes the
    staged source, so `last_clip`'s staging path no longer matches (or
    exists). Missing file → skip silently, no error banner. The in-memory
    imported set guards the edge where the user deleted the clip's track
    and a reset would re-import it.
- `toggleRecord`: fire `start`/`stop`, report errors; no state mutation,
  no direct import — events drive everything. "not recording" from a lost
  race → swallow. `busy` stays as a double-click guard.

### 6. Tests

- Rust e2e (`vtr-tap/tests/e2e.rs`):
  - UDP `/rec/start` → recording; events recorded; `/rec/stop` →
    `session_end`, `last_clip` set.
  - `/rec/start 42.0` with no `/clock` ever sent → header `tl` ≈ 42,
    first event `tl` continues from it.
  - Idempotency: double start → one clip; stop while idle → nothing.
  - `wait since=0` → start/stop events in order (local and OSC-triggered);
    blocked `wait` wakes on event; stale `since` → reset + snapshot;
    `wait` without `since` → baseline (reset + snapshot + seq, no events).
- Editor vitest: `TapManager` wait loop against the existing mock-server
  pattern in `tap.test.ts` (baseline on connect, events, timeout re-issue,
  reset, reconnect re-baselines instead of reusing `since`, retry past the
  5s connect deadline); snapshot-apply as a pure function if extracted;
  snapshot followed by an event re-stating it stays idempotent (no
  `startedAt` reset, no double import).
- Playwright e2e (`e2e/app.spec.ts` pattern): UDP `/rec/start` → rec
  indicator without touching the UI; send OSC events; `/rec/stop` → track
  with the clip appears. Reuse the beacon-interval helper from the tl test.

### 7. Docs

- README: beacon port → control port; document `/clock`,
  `/rec/start [tl] [rate]`, `/rec/stop`, the `tl` sync rule, and the
  control-socket `wait` cmd; fix the stale `/tap/timeline` mention (code
  says `/clock`); note `session_start.tl` in the JSONL schema section.
- `config.rs` doc comment: same stale address fix.
- TODO.md: check off the item.

## Open points (decide while implementing)

- Ring buffer capacity (64 assumed — rec transitions are rare; revisit only
  if event types multiply).
- Server-side wait timeout (25s assumed).
- `/rec/start` while recording stays a no-op; if TD workflow later wants
  per-song clip splits, add `/rec/split` instead of changing semantics.
