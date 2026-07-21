# TD tox rework — protocol v2 client (vtr.tox)

Status: spec draft (2026-07-21). Reworks the TouchDesigner component for protocol v2: the resolver now lives in the `vtr-player` process, so the tox becomes a thin client. Supersedes the playback half of [../td/spec.md](../td/spec.md); its rec/clock design and resolver semantics carry over. The v1 in-TD player was never merged (PR #7 closed); its extension/build sources live on the closed `feat/td` branch and may be cribbed from.

## Background

Protocol v2 (see the top-level README, "OSC control") moved everything server-side:

- Control messages go to the tap's **listen port** (default 10010) under the `/vtr` prefix. Port 10012 is gone.
- Playback resolution runs in `vtr-player`. Push consumers (Resolume etc.) get UDP; TD **pulls**: a per-frame sync query over the player's unix socket (`{"cmd":"resolve","t":…}` → delta events), applied synchronously before the frame cooks. `td/src/vtr_core` + its pytest suite stay the resolver-semantics reference.
- The player keeps per-connection resolver state: the first `resolve` on a connection is a full catch-up, a jump in queried `t` *is* the seek, reconnects re-baseline automatically. Seek catch-ups are deduped against the connection's last-emitted values.

The tox therefore has no session parsing, no indexes, no resolver — two thin pages.

## Component shape

`td/vtr.tox` — Base COMP + Python extension (`VTRExt`), two custom pages. Built by an idempotent generator script run in the TD textport (same approach as v1's `build_vtr.py`).

## Rec page (unchanged semantics, new addresses)

Fire-and-forget UDP to `Taphost:Tapport` (default `127.0.0.1:10010` — the listen port, merged with app traffic).

- `Record` (Toggle) — ON sends `/vtr/rec/start <t> <rate>` (t = root timeline seconds: the official sync mechanism; with a session loaded the player also primes punch-in state at `t`), OFF sends `/vtr/rec/stop`. Both idempotent on the tap side.
- `Clock` (Toggle, default ON) + `Clockrate` (Int, default 10) — send `/vtr/clock <t> <rate>` at Clockrate Hz, also while paused (`rate` 0): beacon age keeps `tl` stamping alive.
- `Taphost` (Str, `127.0.0.1`) / `Tapport` (Int, `10010`).

No `/vtr/rec` echo handling: the tox owns its Record state; the echo exists for stateless controllers (TouchOSC).

## Play page (new: sync-query client)

- `Sockpath` (Str) — `vtr-player.sock` path; default the editor dataDir (`~/Library/Application Support/VTR/vtr-player.sock` on macOS), `~` expanded.
- `File` (File) + `Reload` (Pulse) — sends `{"cmd":"load","path":…,"triggers":[…]}`. Reply (duration, event/address counts, skipped) surfaces in an info DAT. Note: the player holds **one global session** — a load here swaps it for every client and stops the push transport.
- `Locktotimeline` (Toggle, default ON) + `Offset` (Float) — queried position = root timeline seconds − Offset.
- `Play` (Toggle) + `Rewind` (Pulse) — internal transport when the lock is OFF; position advances with `absTime` while playing.
- `Triggerpatterns` (Str) — space-separated OSC address patterns (`*`, `?`, `[]`, `{}`), passed to `load`; matching happens server-side (v1 used `tdu.match`; the player's matcher covers the same subset).

### Per-frame query & apply

In `onFrameStart`: send `{"cmd":"resolve","t":pos}` (with an id), block on the reply with a small budget (`Querytimeout`, default 2 ms), apply the returned events synchronously:

- **State table** (`state` DAT): one row per address — `port addr args…` — updated with the latest value. This is the primary output; projects read it (DAT-to-CHOP for numeric channels).
- **Callbacks DAT**: `onEvents(events)` fires with the full delta list, in order — the hook for triggers and arrival-sensitive consumers (the state table alone would collapse repeated pump events).
- `Emitosc` (Toggle, default OFF) + `Playhost`/`Playport` — legacy migration mode: additionally re-emit the delta as OSC to the project's OSC-in. Documented cost: arrives one frame late; new projects should read the table/callbacks instead.

Replies are **never discarded**: a reply that misses the frame budget is applied on arrival next frame (matched by id). Discarding would desync the server's per-connection `prev` state and silently drop pump events; the budget bounds per-frame blocking, not correctness.

### Degraded mode

On timeout, apply nothing — state freezes on the last applied values. After `N` consecutive misses (default 5): mark the tox degraded (UI badge + info DAT), stop per-frame queries, probe with `{"cmd":"status"}` every ~1 s. On success, resume; a dropped-and-reconnected socket is a fresh connection, so the next `resolve` is a full catch-up — no client-side resync logic needed. Behavior beyond freezing (e.g. auto-switch to live input) stays an open question until real stage experience.

## Removal

- The local Python player path is gone for good: no session loading, no numpy, no per-frame resolver in TD. `td/src/vtr_core` stays only as the conformance reference (CI pytest job unchanged).
- Delete the stale pre-rework `td/vtr.tox` (built against v1, port 10012 — dead protocol).

## Repo layout

```
td/
  vtr.tox            # built artifact (checked in)
  src/vtr_core/      # conformance reference — untouched by this task
  src/vtr_ext.py     # TD extension: pages, clock/rec, sync-query client
  build/build_vtr.py # run inside TD to (re)generate vtr.tox
  tests/             # pytest for vtr_core (unchanged)
```

## Manual verification checklist (needs TD + `./run`)

1. Rec: Record toggle starts/stops clips with the editor open and closed; clips carry `tl` from the Clock beacon; Record ON while a session is loaded primes punch-in state to the app.
2. Play: File load surfaces duration/counts; timeline drag scrubs (forward pump, backward coalesced catch-up); trigger addresses fire on forward play only; state freezes (badge shown) when the player is killed, recovers when it respawns.
3. No re-recording: replay traffic never reaches the tap's listen port.
4. Query cost: resolve round trip stays inside the 2 ms budget at a realistic session size.

## Out of scope

- Editor preview delegating to vtr-player (separate follow-up).
- Ableton Link / SMPTE bridge, SQLite sessions, non-realtime rendering.
