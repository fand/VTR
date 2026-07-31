# TODO

Refactor backlog. Branch: `refactor/cleanup` (based on `fix/curve-resolution-diff`).
Done so far: dead code, write_line throttle, playhead key unification,
curve golden fixture (+ serde_json float_roundtrip fix), vtr-core crate,
ControlChannel/ChildSupervisor, CurvePanel decomposition, uiScale
(zoomSlider + useElementSize), overlay transforms in shared/edits.ts,
pick_latest_or_earliest (vtr-player/src/pick.rs; resolve_at +
curve_group_args now share it, new conformance cases pin the clamp/ties),
editor main split (register*Ipc + AppContext), dialog seam
(dialogs.ts/nativeDialogs.ts), shared/jsonl.ts + session_lines.jsonl
golden fixture, App.tsx decomposition (useShortcuts/useSelection/
useProjectFile/useTransport/useTapStatus + components/, 1729→858 lines).

## Known issue (pre-existing, found 2026-07-30)

5 curve e2e specs fail on `main` too (pixel-interaction tests:
curve-edit.spec.ts knot drag, curve.spec.ts transform box / snap /
pencil / marquee — all `toHaveCount` misses). Not caused by this branch;
needs its own investigation.

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
- **Split vtr-tap/src/tap.rs (~1500 lines)** — hoist the 3 inline thread
  bodies out of `Tap::start` (`recv_loop`/`control_loop` next to the
  existing `writer_loop`); optional module split (beacon/eventlog/notify/
  jsonl/writer).
- **ControlError enum (Rust)** — three error styles today: anyhow at the
  boundaries, `Result<T, String>` through the tap actor handle (5x
  "writer thread gone" literals), free-form `json!({"ok":false,...})` in
  both control layers.
- **Timeline/CurvePanel pinch + marquee/drag-gesture hooks** — deferred
  from the uiScale step. The pinch anchor timing differs on purpose
  (Timeline clamps in the parent, CurvePanel locally); pointercancel
  semantics differ on purpose (Timeline aborts, CurvePanel commits).
  Only worth it with a design that keeps those differences explicit.
- **grid/tick step logic** — CurvePanel's GRID_STEPS/gridStep (now in
  curveModel.ts) vs Timeline's RULER_STEPS/rulerStep, both hardcoding the
  same 90px label width; could live beside formatRulerLabel in
  timeline/model.ts.
