# TouchDesigner component (vtr.tox)

Status: spec agreed (2026-07-18); the playback architecture was superseded on 2026-07-20 by the server-side resolver (`vtr-player`; protocol v2 in the top-level README, tox client spec in [../tox-rework/spec.md](../tox-rework/spec.md)) — kept for the resolver semantics (now the conformance reference) and the rec/clock design. Plan: [plan.md](plan.md).

## Background

TD is the VJ app on the other side of osc-tap: controllers send OSC to the tap's listen port (10010), the tap forwards unchanged to TD (10011) and takes `/clock` / `/rec/*` on the control port (10012). Today nothing on the TD side speaks that control protocol, and replaying an exported `session.jsonl` requires launching the editor (its preview feature). This task adds a single reusable TD component that closes both gaps.

Decisions from the design discussion:

- **Single tox** (`vtr.tox`) holding both the record and playback features. Split into recorder/player toxes later only if it gets unwieldy.
- **Clock `t` = TD root timeline seconds** (`op('/').time.seconds`). `rate` is the root timeline rate while playing, `0` while paused.
- **Clock beacon is always on** (toggleable), not gated on recording. Losing the beacon only degrades `tl` stamping after 5 s, and always-on is simpler and safer.
- **Playback = loopback OSC (plan “a”)**: the player reads the session file and sends OSC to TD's own OSC-in port, so the project's existing OSC routing is reused untouched. Direct channel dispatch (b) was rejected because it would re-implement the project's OSC mapping; CHOP conversion (c) was rejected because uniform sampling costs rate × duration × channels regardless of activity (40 min × 200 ch × 120 Hz ≈ 58 M samples ≈ 230 MB minimum, before TD's copy-per-operator), and CHOPs cannot represent strings or one-shot triggers.
- Scrub / reverse / mid-session start are **state-resolution problems, not format problems**, so (a) supports them: continuous forward playback is an event pump, and any jump is resolved by per-address catch-up (last event ≤ target per address).
- In-memory representation is **columnar numpy arrays** (~20 B/event), so tens of millions of events stay in the hundreds of MB. If real-world sessions outgrow that, the agreed escalation path is switching the export format itself to SQLite with a baked-in snapshot table (events + snapshots + addr table; seek = 1 snapshot row + 1 bounded delta range query). **Deferred** until a real session actually hurts — v1 ships (a) as specced here.
- State-resolution core is **pure Python with no TD imports**, unit-tested with pytest outside TD.

## Spec

### Component shape

`td/vtr.tox` — a Base COMP with a Python extension (`VTRExt`) and two custom parameter pages.

### Rec page

- `Record` (Toggle) — ON sends `/rec/start <t> <rate>` (t = current root timeline seconds; this is osc-tap's official sync mechanism), OFF sends `/rec/stop`. Fire-and-forget UDP; both commands are idempotent on the tap side, so UI/tap state can never wedge.
- `Clock` (Toggle, default ON) — send `/clock <t> <rate>` at `Clockrate` Hz (default 10). Sent even while the timeline is paused (`rate` 0), because beacon age is what keeps `tl` stamping alive.
- `Controlhost` (default `127.0.0.1`) / `Controlport` (default `10012`).

### Play page

> **Superseded (2026-07-20):** playback moved to the vtr-player process — see [../tox-rework/spec.md](../tox-rework/spec.md). The Play page becomes a sync-query client (`load` + per-frame `resolve`); the sections below stay as the resolver-semantics reference, ported to Rust with `td/src/vtr_core` as the conformance suite.

- `File` (File) — an exported `session.jsonl`. On change: parse, build indexes (synchronously in v1; a huge file blocks the UI for a few seconds — acceptable, revisit only if it hurts).
- `Locktotimeline` (Toggle, default ON) + `Offset` (Float, seconds) — playback position = root timeline seconds − Offset. Pausing the TD timeline and dragging it is scrubbing; no extra transport UI needed.
- `Play` (Toggle) + `Rewind` (Pulse) — internal transport used when `Locktotimeline` is OFF; position advances with `absTime` while playing.
- `Triggerpatterns` (Str) — space-separated OSC address patterns (TD `tdu.match` syntax). Matching addresses are one-shots with no state: they fire only during continuous forward playback and are suppressed during seek / catch-up / reverse.
- `Playhost` (Str, default empty = `127.0.0.1`) / `Playport` (Int, default 0 = auto) — overrides for the emit destination.

### Emit destination

The `session_start` header carries `routes: ["<listen>-><forward>"]`. Events store their listen port; the player maps it through routes and emits to the **forward** port (TD's OSC-in). Never send to the listen port: the tap would re-record and re-log the replay. One `oscout` DAT per destination port, created lazily.

### Playback engine

Position is computed every frame; the engine compares it to the previous position:

- **Continuous forward** (0 < Δ ≤ jump threshold, default 0.5 s): dispatch all events in `(prev, pos]` in order — full fidelity, no coalescing, triggers fire.
- **Seek** (forward jump > threshold, any backward move, file load, transport start): per-address catch-up — for each address with an event ≤ pos, emit its last value; coalesced (one message per address), triggers suppressed. Backward scrubbing is a seek every frame, restricted to addresses touched in `(pos, prev]`, so it stays cheap.

### In-memory model

Built once per file load, all time-sorted:

- `t` (float64) and `addr_id` (int32) numpy columns over all events; numeric args packed into a shared float64 pool via `(offset, count)`; non-float args (strings etc., per `types`) in a sparse dict fallback keyed by event index.
- Address table: id ⇄ (address, port), plus per-address arrays of event indices for `searchsorted` catch-up.
- Header routes and `session_end` duration.

### Repo layout

```
td/
  vtr.tox            # built artifact (checked in)
  src/vtr_core/      # pure Python: parser, indexes, playback resolver — no TD imports
  src/vtr_ext.py     # TD extension: parameters, clock/rec, per-frame cook
  build/build_vtr.py # run inside TD to (re)generate vtr.tox from src/
  tests/             # pytest for vtr_core
  README.md          # build & usage
```

## Out of scope

- SQLite export format + snapshot table (escalation path, see above).
- Memmap / sidecar cache for the JSONL loader.
- Recorder/player tox split.
- Surfacing tap recording state (rec confirmation) in the tox UI.
