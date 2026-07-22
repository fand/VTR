# Plan: vtr.tox — mode-switched sync client (record / player)

Status: agreed (2026-07-21). Spec: [spec.md](spec.md); this plan applies the
mode-switch decisions below on top of it.

## Spec deltas (2026-07-21)

Still one tox, but record and player become an explicit **Mode switch**, not
two always-active pages:

- **record** (realtime, live use): TD *follows* VTR. When recording starts
  anywhere — editor via the tap's unix-socket `start`, or a controller via
  `/vtr/rec/start` — the tap notifies the tox with the timeline time; the tox
  seeks the root timeline to `tl` and starts playback. The clock beacon then
  runs exactly as specced (`/vtr/clock <TD t> <rate>` at Clockrate Hz), so
  after the initial seek TD's *actual* timeline is what gets stamped —
  sync without any drift-correction loop.
- **player** (offline rendering): every frame, `onFrameStart` **blocks** on
  `{"cmd":"resolve","t":…}` and applies the reply before the frame cooks.
  This replaces spec.md's 2 ms budget / apply-late-replies / degraded-mode
  machinery entirely: offline rendering must be deterministic, so the query
  is synchronous, full stop. Realtime preview through player mode just pays
  the blocking cost (fine on localhost); the stage path is record mode.
  "Non-realtime rendering" moves from out-of-scope to the point of the mode.
- Mode gates all I/O: record mode never touches the player socket; player
  mode sends no clock/rec OSC and ignores rec notifications.

## Design

### New tap surface: rec notifications → TD

The tox must hear "recording started at `tl`" no matter who initiated it.
The datagram relay can't provide that (socket-API `start` produces no
datagram), so hook the rec state transition itself — the same place
`rec_started` / `rec_stopped` are appended to the tap's event log:

- Config: `--td-notify <addr>` (default off; the editor spawns the tap with
  `127.0.0.1:10014`). UDP to a dead port is harmless, so the editor enables
  it unconditionally.
- On start: send `/vtr/rec/start <tl> <rate>` (args omitted when the clock
  is unknown). On stop: `/vtr/rec/stop`.
- Plain, unwrapped OSC — not the `"v1 <origin>"` relay framing — so a TD
  `oscin` DAT parses it natively.

### Tox shape

Base COMP + `VTRExt`, three custom pages. Rec/Play page parameters carry
over from spec.md unchanged unless noted.

- **VTR**: `Mode` (Menu: `record` / `player`).
- **Record**: `Taphost`/`Tapport` (fire-and-forget `/vtr/*` to the listen
  port), `Record` toggle, `Clock` toggle + `Clockrate`, plus new
  `Notifyport` (Int, default 10014).
- **Player**: `Sockpath`, `File` + `Reload`, `Locktotimeline` + `Offset`,
  `Play` + `Rewind`, `Triggerpatterns`, `Emitosc` + `Playhost`/`Playport`.
  `Querytimeout` is gone (see deltas).

### Record mode

- `oscin` DAT bound to `Notifyport`. On `/vtr/rec/start tl rate`: seek the
  root timeline to `tl`, start playback. On `/vtr/rec/stop`: keep playing
  (decided 2026-07-21 — a rec stop must not yank the visuals).
- Record toggle and clock beacon: unchanged from spec.md. The Record toggle
  (TD-initiated rec) stays — it's cheap, idempotent, and its
  `/vtr/rec/start <t>` round-trips through the tap back to the notify port,
  where seeking to the time TD is already at is a no-op.

### Player mode

- Unix-socket JSON Lines client on Python's `socket` (blocking). Connect
  lazily on first use; on connect/IO error show an error badge + info DAT
  row and retry ~1 s — no per-frame budget, no reply deferral.
- `File` change / `Reload` → `{"cmd":"load","path":…,"triggers":[…]}`;
  reply (duration, counts, skipped) into the info DAT. One global session
  per player process, as specced.
- Per frame in `onFrameStart`: position = root timeline seconds − `Offset`
  (lock ON) or the internal transport (lock OFF); send
  `{"cmd":"resolve","t":pos}`, block on the reply, apply before cook:
  state DAT (`port addr args…`, latest value per address), callbacks DAT
  `onEvents(events)` with the ordered delta, optional `Emitosc` re-emit.
- A dropped socket reconnects as a fresh connection, so the next `resolve`
  is a server-side full catch-up — no client resync logic.
- macOS-only for now: CPython on Windows exposes no `AF_UNIX` (TD bundles
  CPython). Documented limitation; TCP-localhost fallback only if it ever
  matters.

## Steps

1. `vtr-tap`: `--td-notify` config + OSC emit on rec transitions (both the
   socket-API and `/vtr/rec*` paths) + unit/e2e tests.
2. `vtr-editor`: spawn the tap with `--td-notify 127.0.0.1:10014`; adjust
   spawn-arg tests.
3. `td/src/vtr_ext.py`: extension — Mode gating, record follower
   (oscin callbacks → seek + play), clock/rec sender, player sync client
   (crib page/clock/rec scaffolding from the closed `feat/td` branch).
4. `td/build/build_vtr.py` (idempotent textport generator, also from
   `feat/td`), generate `td/vtr.tox`, write `td/README.md` (build steps,
   parameter docs, manual checklist).
5. Docs: top-level README (component entry, `--td-notify`), progress notes
   in `../td/progress.md` pointing here.
6. Manual verification in TD (needs a TD install + `./run`).

`td/src/vtr_core` + pytest suite stay untouched (conformance reference).

## Verification

- `cargo test` (tap notify paths), editor unit tests.
- Manual checklist additions on top of spec.md's:
  - Rec started from the editor *and* from a controller both seek TD to
    `tl` and start playback; clips stamp `tl` consistently after the seek.
  - Player mode: two offline exports (Export Movie, non-realtime) of the
    same session produce identical frames; killing vtr-player mid-render
    fails loudly (badge + frozen state) instead of silently desyncing.
  - Replay traffic never reaches the tap's listen port.

## Resolved questions (2026-07-21)

- `/vtr/rec/stop` in record mode: **keep TD playing**. A rec stop is a
  logging event, not a transport command.
- Following `/vtr/play` / `/vtr/stop` / `/vtr/seek` in record mode
  (editor-preview scrub follow): **deferred** — revisit as a follow-up
  after the rec path ships; it would need the transport datagrams fanned
  out to TD too, not just rec transitions.
- macOS-only player mode (no `AF_UNIX` in Windows CPython): **accepted**;
  TCP-localhost fallback only if it ever matters.

## Open questions

- `rate` from `/vtr/rec/start`: v1 seeks and plays at rate 1; honoring
  fractional rates on the TD timeline is untested territory.
