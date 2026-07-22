# Plan: tl-sync — bidirectional TD/editor timeline sync

Status: agreed (2026-07-22). Spec: [spec.md](spec.md). Five phases in
dependency order; each is independently testable and committable. Phases
1–3 complete the editor side and run entirely in CI (cargo + vitest); a TD
install is needed only from phase 4 on.

## Phase 1 — transport gen/origin + sessionless seek (Rust, foundation)

`osc-tap/vtr-player/src/transport.rs`:

- `TState` gains `gen: u64`, `origin: String`, `last_write: Instant`.
- `play` / `stop` / `seek` take an `origin: &str` and apply the hold rule
  first: accept iff `origin == last_origin` or `last_write` is older than
  `HOLD_MS` (400 ms). Accepted writes bump `gen` and stamp
  `origin`/`last_write`; rejected writes are silent no-ops.
- Seek application moves **ahead of** the session check in `emit_loop`:
  the mailbox always updates `TState` (playhead is session-independent);
  resolve/emit still requires a loaded session. `on_load` keeps its
  rewind + mailbox clear.
- Tests: gen monotonicity across accepts, hold accept/reject matrix
  (same-origin within window, foreign within window, foreign after
  window), sessionless seek moves `playhead()`, `on_load` still resets.

Commit: `feat(player): transport gen/origin + hold rule + sessionless seek`

## Phase 2 — control protocol extension (Rust)

`control.rs`, `relay.rs`:

- `play` / `stop` / `seek` parse optional `"origin"` (default `""`) and
  pass it through; `transport_reply`, `resolve`, and `status` replies gain
  `gen` + `origin`. Old clients see additive fields only.
- New `watch` command: `{"cmd":"watch","gen":N}` blocks until transport
  gen ≠ N or a ~1 s server timeout, replies
  `{"ok":true,"gen":M,"origin":…,"t":T,"playing":B}`. Implementation:
  condvar signaled on accepted writes (or a short internal poll loop if
  that stays simpler — decide in review; per-connection threads make
  blocking safe either way).
- `relay.rs` passes origin `"osc"` on `/vtr/play|stop|seek`; the
  `/vtr/rec/start` punch-in seek keeps origin `""`.
- Tests: origin-less requests behave exactly as today (compat), watch
  immediate-return on stale gen, watch wakes on write, watch timeout
  shape, relay origin stamping.

Commit: `feat(player): origin on transport cmds, gen in replies, watch long-poll`

## Phase 3 — editor follower (TypeScript)

`osc-editor/src/main/player.ts`, `index.ts`, preload/renderer:

- `PlayerManager.play/stopTransport/seek` send `origin:"editor"`; new
  `watch(gen)` method with a longer per-request timeout than
  `REQUEST_TIMEOUT_MS` (the long-poll must outlive the server's ~1 s
  window).
- Main keeps one `watch` outstanding (re-issue on reply/timeout, pause
  while the player is down — the existing reconnect plumbing gates it).
  On a reply with foreign origin and moved gen: forward
  `{t, playing, origin}` to the renderer via `webContents.send`; if
  previewing, apply through the existing paths (`preview.seek(t)`,
  play-from / `preview.stop()`).
- Session residency: inline-load on project open and after edits
  (debounced, ~300 ms) instead of only on `preview:play`; `preview:play`
  then just seeks + plays. Same single-global-session semantics as today.
- Renderer: playhead follows watch updates when idle; extrapolates from
  `(t, playing, receivedAt)` between updates while playing. Optional
  cosmetic "following td/osc" indicator.
- Tests (vitest): watch loop echo suppression (own origin ignored),
  foreign-origin apply paths, debounced residency load, extrapolation.

Commit: `feat(editor): follow player transport (watch loop + session residency)`

## Phase 4 — tox sync mode (Python + tox rebuild)

`td/src/vtr_ext.py`, `td/build/build_vtr.py`:

- `Positionmode` menu gains `sync` (`timeline` / `follow` / `internal`
  unchanged).
- `_player_tick` sync branch implements the spec's two-threshold
  algorithm: predict `expected` from the last applied position +
  transport play state; `|actual − expected| > JUMP_EPS` (0.25 s) →
  `{"cmd":"seek","t":actual − Offset,"origin":"td"}`; play-flag mismatch →
  `play`/`stop` with origin `"td"`. Then the (single, same-as-today)
  `resolve {follow:true}` round trip: on moved gen with foreign origin,
  glue `timeline.frame`/`timeline.play` to the reply; else drift-correct
  silently when beyond DRIFT_EPS (2 frames). Apply events as today.
- Reconnect re-baselines from the transport (adopt, don't write); while
  disconnected the tox writes nothing. Heartbeat keeps the tick alive
  through a paused timeline (existing mechanism).
- Rebuild `td/vtr.tox` via the textport generator (needs TD, manual).

Commit: `feat(td): sync position mode (bidirectional timeline sync)`

## Phase 5 — verification + docs

- Run spec.md's manual checklist (needs TD + `./run`); tune
  JUMP_EPS/DRIFT_EPS on hardware — the spec values are starting points.
- Docs: top-level README (`/vtr` control table note on origin, component
  blurbs), `td/README.md` (`Positionmode` row + checklist items), TODO.md
  (mark seek-sync item done).
- Regression: offline render (`timeline` mode) byte-identical; existing
  cargo/vitest/e2e suites green.

Commit: `docs: tl-sync README/TODO updates` (+ any tuning as
`fix(td): …`)

## Non-goals held from spec.md

Delivery-path unification (preview → player delegation), record mode,
offline rendering semantics, Windows. `td/src/vtr_core` + pytest stay
untouched — the resolver is not involved in this task.

## Risks

- **Threshold tuning (phase 4)** is where uncertainty concentrates: frame
  quantization vs JUMP_EPS false positives. Mitigation: both constants
  are module-level and adjustable without touching the algorithm; the
  hold rule bounds the damage of a false user-seek detection to one
  bounce.
- **Watch vs request timeout interplay (phase 3)**: a `watch` reply
  arriving after a client-side timeout is dropped by the id filter —
  harmless, but the loop must re-issue on timeout, not treat it as an
  error.
- **Session residency** makes the editor swap the player's global session
  earlier (open vs first play). Anyone using the tox `File` workflow
  alongside an open editor already loses the session on first play; this
  only moves that moment. Documented in README.
