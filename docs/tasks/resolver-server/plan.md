# Plan: resolver server (vtr-player) & protocol v2

Status: draft (2026-07-20). Implements [spec.md](spec.md). Scope: osc-tap changes, the new vtr-player crate, and osc-editor integration. The TD tox sync-query client (Rec/Play page rework) is planned separately once this lands.

## Shape

1. Convert `osc-tap/` into a cargo workspace; add the `vtr-player` member crate.
2. Protocol v2 in the tap: `/vtr/*` on listen ports, relay to the player, delete port 10012 and the bare `/clock` / `/rec/*` addresses.
3. vtr-player core: port `td/src/vtr_core` (session loader + resolver) to Rust with the pytest suite translated as the conformance tests.
4. vtr-player process: relay receiver, push transport, punch-in, echo, sync query API over a unix socket.
5. osc-editor: spawn/monitor the player, beacon-port setting becomes echo-port, packaging.
6. CI, READMEs, docs.

## Decisions (confirmed 2026-07-20, folded into the spec)

- **Workspace layout**: keep `osc-tap` as the root package of `osc-tap/Cargo.toml` and add `[workspace] members = ["vtr-player"]`, so the new crate lives at `osc-tap/vtr-player/`. Minimal churn: `osc-tap/src` stays put, both binaries land in `osc-tap/target/{debug,release}/`, so `tapBinary.ts` path logic and CI keep working.
- **Relay**: tap → player over loopback UDP, default `127.0.0.1:10013` (`--relay` flag on both sides). Framing: `"v1 <ip>:<port>\n"` header followed by the raw OSC bytes. Fire-and-forget `send_to`; a dead player is invisible to the tap.
- **Bundle rule**: a datagram is control iff it is a message whose address starts with `/vtr/`, or a bundle containing at least one such message. Hot-path cost stays flat: a cheap `memmem` scan for `/vtr/` on the raw bytes decides whether a bundle needs decoding at all; bundles without a hit are forwarded as raw bytes exactly as today. A scan hit that decodes to no `/vtr/`-prefixed message address (false positive — e.g. `/vtr/` inside a string arg, or an address like `/x/vtr/y`) is forwarded raw unchanged. In a mixed bundle the `/vtr/*` elements are handled and the non-`/vtr` siblings are dropped with a rate-limited warning (a consumed datagram is never partially re-encoded and forwarded — that would break byte fidelity).
- **Player sockets/paths**: unix socket `vtr-player.sock` next to `osc-tap.sock` (editor dataDir; `--control` flag with a cwd-relative default like the tap's). Player runs as an editor child process only — no launchd mode, since recording never depends on it.
- **Echo is rec-state only, over same-address round trips**: TouchOSC controls send and receive on one address, so feedback must mirror a command address. The controller-facing rec control is the new toggle `/vtr/rec <0|1>` (tap: `1` → start clip without beacon seed, `0` → stop, both idempotent); the player echoes `/vtr/rec <0|1>` on rec-state change. `/vtr/pos` is dropped — the controller has no seek/transport UI; `/vtr/play` / `/vtr/stop` / `/vtr/seek` stay as-is (sent by the editor or custom apps, no echo). Origin registry: 3-minute expiry; on first contact from a new origin, echo the current `/vtr/rec` once immediately (initial sync for late-started controllers).
- **`/vtr/clock` multi-sender arbitration**: last-write-wins (each datagram overwrites the beacon) + rate-limited warning when a second source is seen within a few seconds. No owner lock.
- Deferred as spec'd: TD degraded-mode behavior beyond freezing (revisit with real stage experience, in the tox task).

## Steps

### 1. Workspace conversion (`osc-tap/Cargo.toml`, `osc-tap/vtr-player/`)

- Add `[workspace] members = ["vtr-player"]` (+ `resolver = "2"`) to `osc-tap/Cargo.toml`; scaffold `vtr-player/` with `main.rs` printing a version and an empty `lib.rs`.
- Move shared deps (`rosc`, `serde`, `serde_json`, `anyhow`, `clap`) to `[workspace.dependencies]`; both crates reference them with `workspace = true`.
- Verify `cargo test` from `osc-tap/` runs both members and that `./run` / `tapBinary.ts` still find the tap binary (target dir is unchanged).
- Add the `player` scope to the conventional-commit scopes in `CLAUDE.md`.

### 2. Protocol v2 in the tap (`osc-tap/src/tap.rs`, `main.rs`, `config.rs`, `control.rs`)

- **recv thread** (`tap.rs:300`): before the raw forward, run the bundle-rule check above. On a `memmem` hit the datagram is decoded (`flatten` reused) and classified in place — decoding here (not in the control thread) keeps app ordering intact: a false positive is forwarded raw from the same thread, in order. Real control datagrams are handed off via `try_send` (small bound, rate-limited drop warning) to the control thread; they never reach the app or the writer. The recv thread's worst case stays memmem + a rare decode + try_send — no blocking calls.
- **control thread** (the beacon thread repurposed: same thread, new inbox — fed by the recv channel instead of its own socket): receives `(origin, raw bytes, decoded msgs)` and does all dispatch — beacon update, rec start/stop, relay send. Rationale for not dispatching inline in recv: `start_clip` blocks on a writer round trip that opens the clip file (`tap.rs:252`); inline, that stall would sit on the 120 Hz listen socket — the exact loss the tap guards against.
- Re-plumb the beacon-thread handlers (`tap.rs:342-406`) onto the control thread's dispatch: `/vtr/clock [t] [rate]` updates the shared `Beacon` (last-write-wins across senders; track the last source and emit a rate-limited warning when it flips within a few seconds), `/vtr/rec/start [t] [rate]` seeds the beacon and starts a clip (idempotent), `/vtr/rec/stop` stops it, and the new controller-facing toggle `/vtr/rec 0|1` maps onto the same start (without beacon seed) / stop paths. Arg validation unchanged (`arg_as_f64`). Unknown `/vtr/*` addresses: rate-limited log, drop. Then delete the beacon socket, `--beacon`, and `Config.beacon`.
- **Relay**: every control datagram (including `/vtr/clock` and addresses the tap itself handled) is wrapped with its origin and sent to the relay addr from the control thread. New `--relay` flag, default `127.0.0.1:10013`.
- **Control API**: `start` gains the optional `tl` (and `rate`) the OSC path has (`control.rs:138` dispatch + writer plumbing).
- **Tests** (`tests/e2e.rs`): rewrite the beacon-port tests (`stamps_tl_from_beacon`, `clock_rate_zero_freezes_tl`, `osc_rec_start_and_stop_control_recording`, `rec_start_tl_arg_seeds_the_clock`, `rec_msgs_are_idempotent`, `stale_beacon_omits_tl`, `non_finite_beacon_is_rejected`) to send `/vtr/*` to the listen port. New tests: `/vtr/*` is never forwarded nor recorded; the `/vtr/rec 0|1` toggle starts/stops recording (idempotent, no beacon seed); relay datagram carries origin + payload; mixed bundle drops non-`/vtr` siblings; plain bundles still forward byte-identical; a datagram whose bytes contain `/vtr/` but whose message addresses don't have the prefix (string arg, `/x/vtr/y`) forwards byte-identical; unknown `/vtr/*` dropped; control `start` accepts `tl`.
- Update `osc-tap/README.md` protocol section (v2 table from the spec, 10012 removal).

### 3. vtr-player core: session + resolver (`osc-tap/vtr-player/src/session.rs`, `resolver.rs`, `pattern.rs`)

- `session.rs`: port `vtr_core/session.py` — streaming JSONL loader, columnar storage (`Vec<f64>` t / arg pool, addr & types interning, `raw_args` map for non-numeric), per-address index, `routes` parsed from `"src->dst"`, `duration` with last-event fallback, malformed lines counted in `skipped`, defensive re-sort by t.
- `resolver.rs`: port `vtr_core/resolver.py` — `step(pos) -> Vec<Emit>` with `prev` state, `jump_threshold = 0.5`, pump on small forward deltas (every event in `(prev, pos]`, no dedup, triggers fire), per-address catch-up via `partition_point` on first query / backward / jump (coalesced, touched-addresses-only when prev is known, triggers suppressed), `reset()`.
- `pattern.rs`: OSC address pattern matching for triggers. First try `rosc::address::Matcher`; if its semantics don't match what `tdu.match` provides for our patterns, implement the needed subset (`*`, `?`, `[]`, `{}`). Patterns are supplied at `load` and compiled once into a per-address bool table, like `resolver.py:39`.
- **Conformance tests**: translate all 16 pytest cases (8 + 8) from `td/tests/test_resolver.py` / `td/tests/test_session.py` 1:1 (same names, same inline fixtures). The Python originals stay as the executable reference; add a doc comment pointing at them.
- **Snapshot dedup on seeks** (new vs. vtr_core, per spec): implemented in a connection-layer wrapper around `Resolver` that tracks last-emitted values per address and skips exact-float-equal catch-up emissions. Rust-only unit tests (dedup hit, near-equal floats NOT deduped, dedup state is per-connection, pump emissions also update the last-emitted values so a later seek dedups against what was actually sent).

### 4. vtr-player process (`osc-tap/vtr-player/src/main.rs`, `relay.rs`, `transport.rs`, `echo.rs`, `control.rs`)

- `main.rs`: clap flags `--relay 127.0.0.1:10013`, `--control ./vtr-player.sock`, `--echo-port 9000`, `--tap-control <path>` (optional), `--exit-on-stdin-close`.
- `relay.rs`: UDP receiver for tap-wrapped datagrams — parse origin header, decode OSC, register origin for echo, dispatch: `/vtr/play` / `/vtr/stop` toggle the transport, `/vtr/seek t` requests a seek, `/vtr/rec/start t` triggers punch-in priming (resolve at `t`, emit to app) when a session is loaded. `/vtr/clock` and `/vtr/rec` only refresh the origin registry — rec handling is the tap's business, and the rec echo is driven by the tap event log regardless of which command changed the state.
- `transport.rs`: push transport — playhead (`base_t` + monotonic clock while playing), an emit loop resolving `step(now)` and sending UDP to the forward ports from the session `routes` (overridable at `load`). Seeks go through a one-slot latest-wins mailbox: the emit loop always takes the newest pending seek and stale ones are simply overwritten (drag-safe, no fixed throttle). Emissions use the transport's own dedup-wrapped resolver connection.
- `echo.rs`: origin registry (IP + last-seen; 3-min expiry) → send `/vtr/rec 0|1` to each origin's `IP:echo_port` on rec-state change, and once immediately on first contact from a new origin (initial sync). Rec state comes from a client thread long-polling the tap control socket's `wait` (reconnect with backoff; absent `--tap-control` disables it); each (re)connect starts with a cursor-less `wait` whose baseline `status` snapshot carries the current `recording` flag, seeding the initial rec state without waiting for a change. No position echo.
- `control.rs`: unix-socket JSON Lines server, same framing/id-echo style as the tap's, but **stateful per connection** (each connection owns a dedup-wrapped `Resolver`): `load {path, triggers}` → replies duration/routes/event & address counts; a `load` while active swaps the session atomically, stops the push transport, and resets every connection's resolver + dedup state (the next `resolve` per connection is a full catch-up); `resolve {t}` → `{ok, mode:"pump"|"seek", events:[[port, addr, [args]], …]}`, returned not emitted, first call per connection is a full catch-up; `status` → loaded file, playhead, transport state, connection count.
- **e2e tests** (`vtr-player/tests/e2e.rs`, mirroring the tap's harness): temp session.jsonl + fake app UDP socket + fake controller socket + real unix socket. Cover: load reply fields; push play emits events in order to the route's forward port; seek emits coalesced catch-up and drops stale seeks under a burst; punch-in emits resolved state on relayed `/vtr/rec/start t`; echo `/vtr/rec` reaches the controller origin at the echo port, following a faked tap event log; a new origin's first `/vtr/*` message gets an immediate `/vtr/rec` echo; sync `resolve` returns pump/seek deltas per connection with dedup; replays never hit the listen/relay port.

### 5. osc-editor integration (`osc-editor/src/main/`, `src/shared/types.ts`, `src/renderer/src/App.tsx`)

- `types.ts`: `PortConfig.beacon` → `echo` (default 9000), plus `relay` if we expose it (default: derived, not shown in UI). Migrate `project.json` on load: back-fill `echo: 9000`, drop `beacon` (same pattern as the existing back-fill at `App.tsx:462`).
- `src/main/player.ts`: `PlayerManager` modeled on `TapManager` — child-spawn with `--exit-on-stdin-close`, respawn backoff, JSON-Lines client to `vtr-player.sock`, `status()` polling for the UI. Binary lookup: generalize `tapBinary.ts` to `findBinary(name)`. Pass `--relay` / `--echo-port` / `--tap-control` consistently with `tapArgs`.
- `TapManager.tapArgs`: replace `--beacon` with `--relay`; restart-on-port-change logic unchanged.
- `App.tsx`: beacon port input (`App.tsx:1475`) becomes echo port; beacon status display (`App.tsx:1485-1498`) becomes player status (alive / loaded file / playhead). Recording status stays on the tap wait API, untouched.
- Packaging: bundle `vtr-player` next to `osc-tap` in `Resources/bin`; extend `./run` to build both (workspace build already does).
- Tests: update `tap.test.ts` / `tapBinary.test.ts`, add `player.test.ts`; update `e2e/ports-seek.spec.ts` and `launchd.spec.ts` (launchd covers the tap only).

### 6. CI & docs

- `.github/workflows/ci.yml`: the existing cargo job now tests the whole workspace (both crates) — verify, no new job needed. Keep the `td-tests` pytest job (conformance reference must stay green).
- Update top-level `README.md` / `TODO.md` architecture description; add a superseding note to `docs/tasks/td/spec.md`'s playback section pointing here (the spec already declares this).

## Order & scopes

Steps map to commits roughly 1:1; suggested scopes: 1 `build(tap)`, 2 `feat(tap)`, 3 `feat(player)` (core), 4 `feat(player)` (process), 5 `feat(editor)`, 6 `ci`/`docs`. Steps 3–4 can proceed in parallel with 2 after 1; step 5 needs 2 and 4. Transient breakage between commits is acceptable (confirmed 2026-07-21) — e.g. between steps 2 and 5 the editor still passes `--beacon` to a tap that no longer accepts it, so editor tests/e2e are red until step 5 lands; only the end state must be green.

## Follow-ups

- TD tox rework (separate task): Rec page → `/vtr/*` on the listen port, Play page → sync-query client (`load` on File, per-frame `resolve` into an output table/CHOP with the ~2 ms budget + degraded mode), removal of the local Python player path.
- Editor preview delegating to vtr-player (single resolver everywhere).
- Group-latch catch-up, Link/SMPTE bridge, SQLite sessions, non-realtime rendering — as listed in the spec.
