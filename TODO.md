# TODO

Refactor backlog. Branch: `refactor/cleanup` (based on `fix/curve-resolution-diff`).
Done so far: dead code, write_line throttle, playhead key unification,
curve golden fixture (+ serde_json float_roundtrip fix), vtr-core crate,
ControlChannel/ChildSupervisor, CurvePanel decomposition, uiScale
(zoomSlider + useElementSize), overlay transforms in shared/edits.ts.

## Next: unify "which definition wins at t" (agreed, not started)

Three hand-synced copies of latest-definition-wins + earliest flat-left clamp:

- `vtr-player/src/resolver.rs:196-231` `resolve_at` — event vs curve pick,
  ties go to the curve; its `(None, None)` arm re-derives the same
  comparison against the *earliest* definitions (near-mirror code).
- `vtr-player/src/session.rs:118-170` `curve_group_args` — same shape again
  per arg: latest-def-wins loop + earliest-clamp fallback, ties to the
  later line.

Plan:
1. First check how tightly `tests/conformance_resolver.rs` +
   `conformance_session.rs` pin these paths (ties, clamp, per-arg cases);
   add conformance cases if thin — BEFORE touching the code.
2. Extract a small `pick_latest_or_earliest` helper parameterized by
   (definition time, tiebreak); use it in all three places.
   `resolve_at` (74 lines) should roughly halve.

Risk: core playback correctness; the conformance suites are the net.

## Backlog (from the survey, not yet agreed)

- **OSC↔JSON codec doesn't round-trip** — tap records `Color` as
  `('r', "#rrggbbaa")`, `Inf` as `('I', "<impulse>")`, >2^53 `Long` as a
  decimal string (`vtr-tap/src/tap.rs` `arg_to_json_tagged`); the player's
  `to_osc_args` (`transport.rs:378-402`) re-emits them all as strings and
  never reads the `types` tag. Fix: `osc_json` module in vtr-core owning
  both directions + a round-trip property test. NOTE: changes replayed
  wire bytes for those tag types — confirm it's a fix, not a spec change.
- **Unify the Rust unix-socket JSONL control servers** — tap answers
  long-poll `wait` off-thread; player's `watch` blocks the whole
  connection ~1s (head-of-line). Shared `jsonl_server::serve(path,
  handler)` in vtr-core (stale-socket removal, id echo, bad-json reply,
  off-thread reply affordance). Confirm the editor's player client
  tolerates out-of-order replies before switching (the tap client does).
- **Split editor `main/index.ts`** — 28 ipcMain.handle + module-global
  state, only untested main module. `registerProjectIpc/TapIpc/PlayerIpc/
  WindowIpc/UndoIpc` + an AppContext; makes `requireGranted`/`ensureWithin`
  unit-testable.
- **Dialog seam** — the `hidden` e2e env-var branching (`OSC_EDITOR_*`)
  is smeared over 5 sites in index.ts with 3 different "cancelled"
  encodings. One `main/dialogs.ts` interface, picked once at boot.
- **JSONL line schema single owner (TS side)** — `shared/jsonl.ts` with the
  discriminated union of line kinds, used by `main/session.ts` (writer) and
  `main/clips.ts` (reader; note clips.ts treats any `type == null` line as
  an event). Plus one golden .jsonl fixture read by vitest AND the Rust
  conformance tests.
- **Split vtr-tap/src/tap.rs (~1500 lines)** — hoist the 3 inline thread
  bodies out of `Tap::start` (`recv_loop`/`control_loop` next to the
  existing `writer_loop`); optional module split (beacon/eventlog/notify/
  jsonl/writer).
- **ControlError enum (Rust)** — three error styles today: anyhow at the
  boundaries, `Result<T, String>` through the tap actor handle (5x
  "writer thread gone" literals), free-form `json!({"ok":false,...})` in
  both control layers.
- **App.tsx decomposition** (renderer, 1700+ lines) — 6 separate window
  keydown effects → one `useShortcuts`; extract `useProjectFile`,
  `useTapStatus`, `useTransport`, `useSelection` (the mutually-exclusive
  selection invariant is re-implemented ~8 places); move
  Timecode/NumField/TextField/FileMenu/StatusBar out of App.tsx.
  Careful: menu-vs-keydown "exactly one path fires" contract.
- **Timeline/CurvePanel pinch + marquee/drag-gesture hooks** — deferred
  from the uiScale step. The pinch anchor timing differs on purpose
  (Timeline clamps in the parent, CurvePanel locally); pointercancel
  semantics differ on purpose (Timeline aborts, CurvePanel commits).
  Only worth it with a design that keeps those differences explicit.
- **grid/tick step logic** — CurvePanel's GRID_STEPS/gridStep (now in
  curveModel.ts) vs Timeline's RULER_STEPS/rulerStep, both hardcoding the
  same 90px label width; could live beside formatRulerLabel in
  timeline/model.ts.
