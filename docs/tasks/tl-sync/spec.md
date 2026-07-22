# Timeline sync — bidirectional seek/transport between TD and the editor

Status: implemented (2026-07-22) — player, editor, and tox source landed;
tox binary rebuild and manual TD verification (checklist below) pending.

## Problem

Seeking currently requires picking a master explicitly, and the choice is
static:

- tox `Positionmode` = `follow`: the editor drives. TD reads the player's
  push transport every frame (`resolve {follow:true}`) but never writes —
  dragging the TD root timeline goes nowhere.
- tox `Positionmode` = `timeline`: TD drives. The tox resolves at the root
  timeline's position and ignores the player transport — editor seeks go
  nowhere.

Three playheads exist (editor `Preview`, TD root timeline, player
transport) and writes flow one way only: editor → player (the preview
mirror in `osc-editor/src/main/index.ts`), player → TD (`follow`). The goal:
seek or play/pause **either** in TD or in the editor and have the other
side track automatically — no master switch.

## Design

**The player transport becomes the single authoritative playhead** —
`t` (session seconds) plus `playing` — and both TD and the editor become
read/write followers of it. Only the playhead is synced; OSC event
delivery keeps its existing paths (editor `Preview` push, TD per-frame
resolve). The transport is a shared clock, nothing more.

Loop prevention (the one hard problem) is origin echo suppression:

- Every transport write (`play`/`stop`/`seek`) carries an `origin` string.
  The transport keeps a generation counter `gen` (bumps on every accepted
  write) and the last write's `origin`, and reports both on every read.
- A client applies a remote state only when `gen` moved **and**
  `origin != self`. Its own writes come back as its own origin and are
  ignored — no loop.
- A client writes only on a **user action**, never as a consequence of
  applying a remote state.

"Last-touched wins" then emerges by itself: whoever is dragging generates
writes, the other side follows, and on release everyone just follows the
transport. No explicit master state machine.

### Sticky origin (concurrent-write guard)

Two simultaneous drags degenerate to interleaved last-writer-wins — a tug
of war. Server-side hold: a write is accepted iff `origin == last_origin`
or the last accepted write is older than `HOLD_MS` (default 400 ms).
Rejected writes are dropped silently; the reply still carries the current
transport state, so the losing client simply keeps following. One rule,
enforced in one place, covers every client pair.

### Origins

| origin | writer |
| --- | --- |
| `editor` | editor UI (seekbar, play/stop buttons) |
| `td` | tox sync mode (root-timeline scrub, play/pause) |
| `osc` | relayed `/vtr/play\|stop\|seek` (controllers) — assigned by the relay, not by the sender |

Controllers join the sync for free: a `/vtr/seek` from TouchOSC bumps
`gen` with origin `osc`, and both TD and the editor follow it.

## Protocol changes (vtr-player control API)

Backward compatible: all new fields are optional on requests and additive
on replies.

- `play` / `stop` / `seek` gain optional `"origin":"…"` (default `""`,
  which never matches any follower's self-check — old clients keep
  working, they just can't suppress their own echo).
- Transport replies (`play`/`stop`/`seek`/`status` and `resolve`) gain
  `"gen":N` and `"origin":"…"`.
- New command `watch`: `{"cmd":"watch","gen":N}` long-polls until the
  transport's gen differs from `N` (or a ~1 s server timeout), then
  replies `{"ok":true,"gen":M,"origin":"…","t":T,"playing":B}`. Same
  transport-axis reasoning as the tap's `wait`
  ([../rec-msg/spec.md](../rec-msg/spec.md)): reuses the request/reply
  plumbing, liveness built in, no subscriber registry. `t` is the playhead
  at reply time; between replies the client extrapolates
  (`t + elapsed` while playing) exactly like the transport itself does.
  The server handles each connection's lines strictly in order, so a
  watch client MUST keep the long-poll on its own connection — on a
  shared one it head-of-line-blocks every command, including the very
  write that would wake it.
- `load` gains optional `"origin"` (stamped on the transport reset's gen
  bump, so the loader's own follower suppresses the echo) and
  `"keep":true` (swap the session without touching the transport — no
  stop, no rewind, no gen bump; the resolver-epoch reset still gives
  every connection a full catch-up). The editor's inline loads use both,
  so a residency reload during playback never yanks followers to zero;
  File-workflow loads keep the historical stop+rewind.
- **Seeks apply without a session.** Today `emit_loop` takes the seek
  mailbox only when a session is loaded, so a sessionless `seek` updates
  nothing. The playhead becomes session-independent: `play`/`stop`/`seek`
  always move `TState` (and bump `gen`); only resolve/emit still requires
  a loaded session. `on_load` still rewinds and clears the mailbox.
- The relay passes origin `osc` on `/vtr/play|stop|seek`
  (`relay.rs`). The `/vtr/rec/start` punch-in seek keeps origin `""`
  (internal priming, not a user transport gesture — followers may apply
  it as any foreign-origin write).

## TD tox: `Positionmode` = `sync`

New position mode next to `timeline` / `follow` / `internal`. `follow`
stays as the read-only variant; `timeline` stays the deterministic
offline-render mode (never synced — realtime wall-clock sync and offline
determinism are mutually exclusive).

In sync mode the root timeline is glued to the transport, both ways. TD
gives no "user scrubbed the timeline" event — the only observable is
`op("/").time` — and during playback the timeline advances on its own, so
user actions are detected as **discontinuities against a predicted
position**, with two thresholds:

- `JUMP_EPS` (~0.25 s, ≫ 1 frame): a jump this large is a user seek →
  write it back.
- `DRIFT_EPS` (~2 frames): below this, do nothing; between the two,
  silently re-glue the timeline to the transport (frame quantization and
  wall-clock drift — never written back).

Per tick (onFrameStart, or the existing heartbeat while the timeline is
paused):

```
expected = last timeline pos + (elapsed if transport playing else 0)
actual   = op("/").time.seconds
actual_play = op("/").time.play

# 1. detect user actions → write (origin "td")
if |actual − expected| > JUMP_EPS:        seek(actual − Offset)
if actual_play != expected_play:          play() / stop()

# 2. read + apply (same round trip as today's follow resolve)
reply = resolve {follow:true}             # now carries gen, origin
if reply.gen changed and reply.origin != "td":
    timeline.frame = (reply.t + Offset) * rate + 1
    timeline.play  = reply.playing
elif playing and |actual − (reply.t + Offset)| > DRIFT_EPS:
    timeline.frame = …                    # drift correction, not a user action
apply(reply.events)
update expected from what we just applied/observed
```

The `t + Offset` ↔ `frame` mapping is the same conversion record mode's
`OnNotify` already does. Writes go over the existing control socket
(`{"cmd":"seek","t":…,"origin":"td"}`).

Degraded behavior is unchanged (freeze + 1 s reconnect); while
disconnected the tox writes nothing. A reconnect re-baselines **from the
transport** (adopt `t`/`playing`/`gen` as-is, no write) — the shared state
wins over a stale local timeline.

## Editor

- **Read**: keep one `watch` outstanding (re-issued on reply/timeout, on
  a dedicated connection — see the protocol note). On a reply with a
  foreign origin: move the renderer playhead; a foreign seek during a
  local preview repositions the live stream (without mirroring back —
  that write would be an echo); a foreign play animates the playhead as
  remote-driven only (no OSC push — TD gets events via its own resolve —
  and no end-of-project auto-pause, which would stop the shared
  transport); a foreign stop freezes a running local stream. Between
  replies the renderer extrapolates from `(t, playing, reply time)`.
- **Write**: seekbar / play / stop IPC handlers pass `origin:"editor"` on
  the mirror calls they already make. No new write paths.
- **Session residency**: today the inline session is loaded only on
  `preview:play`, so with the editor idle a TD-side scrub would resolve
  against nothing. The editor instead inline-loads on project open and
  after edits (debounced); `preview:play` just seeks + plays. Same
  single-global-session semantics as today — the editor already swaps the
  player session on every play.

The editor UI may surface the last foreign origin ("following td") as a
small indicator; purely cosmetic.

## Defaults

| constant | value | meaning |
| --- | --- | --- |
| `HOLD_MS` | 400 ms | sticky-origin window (server) |
| `JUMP_EPS` | 0.25 s | TD user-seek detection |
| `DRIFT_EPS` | 2 frames | TD silent re-glue band |
| watch timeout | ~1 s | server-side long-poll timeout |

## Out of scope

- Offline rendering: `timeline` mode is untouched and stays deterministic.
- Record mode: untouched (TD-follows-VTR via rec notifications is a
  different mechanism).
- Delivery-path unification (editor preview delegating emission to
  vtr-player, "resolver 一本化" in TODO.md): orthogonal — this task syncs
  the playhead only. The two compose; either can land first.
- Multiple editors / multiple TD instances writing concurrently beyond
  what the hold rule already handles.
- Windows (`AF_UNIX` constraint unchanged).

## Rejected alternatives

- **Static master selection (status quo)**: the problem statement.
- **Deadband-only, no gen/origin**: a bare "don't write what you just
  applied" check has no defense against interleaved writes and
  accumulates quantization error; with a continuously advancing timeline
  the deadband must be on discontinuity anyway, so gen/origin adds the
  robustness for near-zero extra cost.
- **Explicit master state machine (drag → claim master → release)**: the
  felt behavior (last-touched wins) already emerges from origin echo
  suppression + the hold rule; TD has no scrub-gesture events, so "claim
  on drag" would reduce to the same discontinuity detection plus a state
  machine on top.
- **Editor polls `status` at fixed Hz**: `watch` long-poll gives lower
  latency and less traffic, and matches the rec-msg precedent; steady
  playback needs no traffic at all (extrapolation covers it).
- **Syncing TD over OSC (`/vtr/*` to the tap)** instead of the control
  socket: the tox already holds the socket for per-frame resolve; OSC
  adds a lossy hop and would still need gen/origin surfaced somewhere.
  The OSC path stays what it is — the controller interface.
- **Transport pushes unsolicited lines to control connections**: breaks
  the one-reply-per-request framing every client relies on; `watch` keeps
  the framing.

## Verification checklist (manual, needs TD + `./run`)

1. Editor → TD: seekbar scrub moves the TD root timeline; play/stop in the
   editor starts/pauses TD (sync mode).
2. TD → editor: dragging the TD root timeline moves the editor playhead
   (idle and during preview); TD play/pause reflects in the editor.
3. Controller: `/vtr/seek` from a third device moves both.
4. No loops: after any single seek, both sides settle (no oscillation, no
   re-echo); steady playback generates no writes from either side.
5. Simultaneous drag on both sides: jitters at worst during the overlap,
   converges on release (hold rule).
6. Pause + scrub: syncing works with the TD timeline paused (heartbeat
   path) and with the editor stopped (session residency).
7. Kill vtr-player mid-sync: both sides freeze/degrade, recover on
   respawn, and re-baseline from the transport without a write storm.
8. Offline render (`timeline` mode): byte-identical to pre-change output.
