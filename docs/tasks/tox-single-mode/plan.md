# tox single-mode — implementation plan

Spec: `spec.md`. Four commits, in this order (1–2 before 3: the tox must
stop listening before the tap stops talking).

## 1. player — punch-in from the tap event log

`feat(player): prime and start the transport on rec_started`

The tap client today lives in `echo.rs` (`spawn_tap_client` / `follow_tap`)
and only knows `Echo`. Priming needs `Transport` and `SharedState`, and the
client is currently spawned *before* the transport exists (`lib.rs`).

- **New module `vtr-player/src/tap_client.rs`** — move `spawn_tap_client` +
  `follow_tap` there. Takes `Echo` + `Transport` + `Arc<SharedState>`.
  `lib.rs`: create echo → transport → spawn tap client (reorder; the relay
  spawn is untouched).
- **On `rec_started {clip, tl?}`:**
  - session loaded (`shared.snapshot().1.is_some()`) and `tl` present:
    `transport.prime_seek(tl)` then `transport.play("rec")`;
  - session loaded, no `tl`: `transport.play("rec")` only;
  - no session: do nothing (nothing to resolve; matches today's relay arm).
- **`rec_stopped` / baseline snapshots: transport untouched.** Priming
  fires on the event only — a player that (re)connects mid-take sees
  `recording: true` in the baseline but does not prime (no `tl` there).
  Accepted; note it in the module doc.
- **Drop the `/vtr/rec/start` arm in `relay.rs`** (the `/vtr/*` relay still
  registers origins for echo). `PLAYER_ADDRS` in vtr-core stays as-is: the
  tap consumes `/vtr/rec/*` itself, so its unknown-addr warning never saw
  them anyway.
- **e2e** (`tests/e2e.rs`, extend `fake_tap`):
  - `rec_started {tl}` with a session → `status`: playhead ≈ tl, playing,
    origin `"rec"`, gen bumped;
  - `rec_started` without `tl` → playing, playhead unchanged;
  - no session → no transport change;
  - `rec_stopped` → no transport change;
  - update/remove the existing relay-priming test (search
    `/vtr/rec/start` in e2e.rs);
  - the existing echo/LED test stays green.

## 2. tox — single-mode rewrite

`refactor(td): single-mode tox — no Mode, no Positionmode`

`vtr_ext.py`:

- `OnFrame`: always `_clock_tick()` then `_player_tick()`. Delete
  `_mode()`.
- `_player_tick` branches on `project.realTime`:
  - **on (live):** `_sync_tick` as-is, query timeout ~0.1 s;
  - **off (render):** resolve at `op('/').time.seconds − Offset`, transport
    never read/written, timeout 5.0 s.
  - Track the flag; on an edge call `_sync_reset()` (re-adopt on return to
    realtime, write nothing). Set the timeout via `sock.settimeout()` on
    the edge too (constants `QUERY_TIMEOUT_LIVE_S = 0.1`,
    `QUERY_TIMEOUT_RENDER_S = 5.0`).
- Delete: `OnNotify`, the `Positionmode`/`Play`/`Rewind` branches in
  `OnParChange`/`OnPulse` (`Reload` stays), `_pos`/`_last_abs` (internal
  transport), the `follow`/`internal`/`timeline` request builders.
- Heartbeat stays (a paused timeline in live still needs beacon + sync).
- Module docstring: rewrite around the two automatic branches.

`build_vtr.py`:

- Delete: `Mode` menu, `Positionmode`/`Play`/`Rewind`/`Notifyport` params,
  the `oscin_notify` DAT + `oscin_callbacks` text DAT (`OSC_CALLBACKS`
  const).
- Pages: `VTR Clock` (`Clock`, `Clockrate`, `Taphost`, `Tapport`) and
  `VTR Player` (`Sockpath`, `File`, `Reload`, `Offset`, `Triggerpatterns`).
- Everything else (state/info/chop_out/callbacks/exec/parexec) unchanged.

Rebuild `td/vtr.tox` in TD; commit the binary with this step.

Manual verification (against the step-1 player):

- rec from the editor and from a controller both seek+play TD (via
  transport);
- scrubbing TD mid-take moves the editor playhead (bidirectional stays);
- SIGSTOP the player in live: TD hiccup ≤ ~100 ms, error row set, recovers
  on SIGCONT; recording + forwarding unaffected throughout;
- realtime off: resolve blocks (up to 5 s), two exports of one session are
  frame-identical; toggling realtime back re-adopts without a write-back;
- clips recorded during sync playback carry `tl` (beacon always on).

## 3. tap + editor — remove the notify path

`refactor(tap): drop --td-notify`

- vtr-tap: delete `tap/notify.rs`; remove `notify` from `writer.rs`
  (`Msg::Start`/`Msg::Stop` arms), `tap/mod.rs` wiring, `config.rs`
  (`td_notify`), `main.rs` (CLI arg); fix `soak.rs` / `e2e.rs` /
  `writer.rs` test fixtures (the `td_notify: None` fields and the
  `tox` notify test around `e2e.rs:443`).
- vtr-editor: remove `--td-notify` + `TD_NOTIFY_PORT` from
  `src/main/tap.ts` (and the port constant's definition site).

## 4. docs

`docs: single-mode tox`

- `td/README.md`: rewrite — no modes; the realtime-flag branch table; the
  new manual checklist (step 2's list); "render with realtime off" line.
- Root `README.md`: drop the `--td-notify` section and the tox mode
  description; update the component bullet.
- `docs/ARCHITECTURE.md`: remove :10014 from the port table and diagrams.
- `CLAUDE.md`: the vtr-tap bullet mentions `--td-notify (:10014)` — drop.

## Compatibility while landing

- After 1, before 2: old tox record mode still works (notify is still
  emitted; it never used relay-priming). Old tox player mode: unchanged.
  Double-follow is impossible — record mode doesn't read the transport,
  player mode doesn't read notify.
- After 2, before 3: the tap still sends notify datagrams; nobody listens.
  Harmless UDP.
- Old tap + new tox: fine — the tox only needs beacon input and the player
  socket.
