# Resolver server (vtr-player) & protocol v2

Status: spec draft (2026-07-20; open questions resolved same day, folded into the sections below). Supersedes the playback architecture of [../td/spec.md](../td/spec.md); the rec/clock side of the tox and the resolver *semantics* carry over. Implementation plan: [plan.md](plan.md).

## Background

The v1 player lives inside the TD tox, which means every VJ app needs its own resolver implementation — and apps without scripting (Resolume; also Unity-side simplicity) make that impossible. Decision: move the resolver to the VTR side as a dedicated Rust process; hosts become thin clients.

Decisions from the design discussions (2026-07-18 … 07-20):

- **Resolver is a separate Rust process (`vtr-player`), not part of osc-tap.** Fault isolation: recording must never depend on the player being alive, and the player's file I/O / session loading must not endanger the tap's 120 Hz loss guarantees. IPC cost (one local UDP hop for relay, a unix-socket round trip for sync queries) is negligible.
- **The control port (10012) is removed.** Control messages arrive on the *listen* ports under a reserved `/vtr` prefix — so a TouchOSC layout pointed at the tap can carry rec/transport buttons with a single destination. Pre-release: no backward compatibility; 10012 and the bare `/clock` / `/rec/*` addresses are deleted outright.
- **The freed "control port" config slot becomes the echo port**: feedback to controllers is sent to `source IP : echo port`.
- **`/vtr/clock` never triggers resolution** — it only feeds `tl` stamping while recording, exactly like today's beacon.
- **`/vtr/seek` (and play/stop) exist for push-mode consumers only** (Resolume etc.), sent by the editor or a custom app — the TouchOSC layout carries no transport/seek UI. TD does not use them: its per-frame sync query carries the time, so a jump in queried time *is* the seek.
- **Controller feedback uses same-address round trips.** TouchOSC controls send and receive on one address, so the controller-facing rec control is the toggle `/vtr/rec <0|1>`, echoed back verbatim on state change. Echo is rec-state only — there is no position feedback.
- **TD pulls synchronously**: at frame start the tox queries resolved state over a socket and applies it before the frame cooks. Rust-side resolution keeps the round trip inside a per-frame budget; liveness monitoring + fallback handles player death.
- **Punch-in recording**: `/vtr/rec/start <t>` primes the VJ app with the resolved session state at `t` before recording. Clip placement needs no new work — clips are already auto-aligned via `tlOffset` (`clips.ts` median, `alignClip` in `timeline/model.ts`).
- The existing pure-Python resolver (td/src/vtr_core) becomes the **conformance reference** for the Rust implementation; its pytest suite is the shared fixture set.

## Architecture

```
controller (TouchOSC…) ──UDP──▶ osc-tap listen (10010)
                                  │  non-/vtr: forward unchanged ──▶ VJ app (10011) + record
                                  │  /vtr/clock, /vtr/rec/*: handled by tap (stamping / rec)
                                  └─ every /vtr/*: relayed (with origin) ──▶ vtr-player
TD tox ◀──unix socket sync query──▶ vtr-player ──UDP emit──▶ VJ app (forward ports)
                                        │
                                        └──UDP echo──▶ controllers (source IP : echo port)
osc-editor ── spawns/wraps both; talks to each over its unix-socket JSON API
```

### osc-tap (changes)

- Accepts `/vtr/*` on every listen port. These datagrams are **never forwarded to the app and never recorded**.
- **Bundle rule**: a datagram is control iff it is a message whose address starts with `/vtr/`, or a bundle containing at least one such message (cheap byte scan for `/vtr/` before any decode, so plain app bundles keep the raw-bytes fast path). A mixed bundle is consumed whole: its `/vtr/*` elements are handled, non-`/vtr` siblings are dropped with a rate-limited warning — a consumed datagram is never partially re-encoded and forwarded (byte fidelity). Don't mix `/vtr` and app messages in one bundle.
- Handles `/vtr/clock` and `/vtr/rec/start|stop` natively (beacon + clip start/stop — the current 10012 logic re-plumbed). Recording therefore works with the player *and* the editor dead, preserving the launchd story.
- Relays **every** `/vtr/*` datagram, wrapped with its origin (ip:port; framing is an implementation detail), to vtr-player's internal UDP port. Fire-and-forget; a dead player is invisible to the tap.
- Control port 10012 and the bare `/clock` / `/rec/*` addresses are removed. The unix control API stays (editor + player are its clients).

### vtr-player (new, Rust)

- Loads a `session.jsonl`, holds the columnar model + per-address indexes, resolves state (same semantics as vtr_core, see below).
- **Push transport** for app-side playback: `/vtr/play`, `/vtr/stop`, `/vtr/seek <t>` drive an internal playhead; emissions go to the forward ports (from the session header routes, overridable) — never to listen ports, so replays are never re-recorded.
- **Sync query API** over a unix socket for pull-mode hosts (TD).
- **Punch-in priming**: on relayed `/vtr/rec/start <t>` with a session loaded, resolves state at `t` and emits it to the app. Ordering vs. the tap's clip start is irrelevant: primed messages go straight to the app and are never recorded, and clip events are `tl`-stamped anyway.
- **Echo** to controllers (below). Subscribes to the tap's `wait` event log to learn rec state changes.
- **Internals**: the tap→player relay arrives on loopback UDP, default `127.0.0.1:10013` (`--relay` on both sides); the sync/control unix socket is `vtr-player.sock` next to the tap's (editor dataDir). The player runs as an editor child process only — no launchd mode, since recording never depends on it.

### Protocol v2 — `/vtr` namespace (OSC, on the listen ports)

| Address | Args | Handled by | Effect |
| --- | --- | --- | --- |
| `/vtr/clock` | `t [rate]` | tap | Timeline beacon for `tl` stamping. ~10 Hz. Never triggers resolution. |
| `/vtr/rec` | `0\|1` | tap | Controller-facing rec toggle: `1` starts a clip (no beacon seed), `0` stops it — both idempotent. The same address is echoed back (below), so one TouchOSC toggle both commands and displays rec state. |
| `/vtr/rec/start` | `[t] [rate]` | tap + player | Programmatic senders (TD, punch-in) — a controller button would send its value as `t`, so controllers use `/vtr/rec`. Tap: update beacon (if `t` given), start clip — idempotent. Player: if a session is loaded and `t` given, emit resolved state at `t` to the app first (punch-in). |
| `/vtr/rec/stop` | — | tap | Stop clip. Idempotent. |
| `/vtr/play` / `/vtr/stop` | — | player | Push-transport run/pause. |
| `/vtr/seek` | `t` | player | Jump the push transport to `t`; resolve + emit catch-up. Latest-wins coalescing: only the newest pending seek is resolved, stale ones are dropped (drag-safe without a fixed throttle). |

Arg validation as v1: non-numeric / non-finite args are ignored, the command still runs. Unknown `/vtr/*` addresses are logged (rate-limited) and dropped. Multiple simultaneous `/vtr/clock` senders: last-write-wins (each datagram overwrites the beacon), with a rate-limited warning when a second source is seen within a few seconds — no owner lock, so sender restarts/handovers just work.

### Echo (controller feedback)

- Sent by the player to every origin that has sent a `/vtr/*` message recently (entry expires after 3 minutes of silence), at **source IP : echo port**. Echo port is a single config value (default **9000**, the TouchOSC convention) exposed in the editor where the control port setting used to be.
- The only echo message is `/vtr/rec <0|1>`, on rec state change (from the tap event log, so it reflects reality regardless of which command — `/vtr/rec`, `/vtr/rec/start`, control API — changed the state). There is no position echo: the controller has no seek/transport UI, and since TouchOSC controls send and receive on the *same* address, a status-only address like the earlier draft's `/vtr/pos` would have nothing to bind to (dropped 2026-07-20).
- **Initial sync**: on first contact from a new origin, the current `/vtr/rec` value is echoed once immediately, so a controller started mid-session shows correct state without waiting for the next change.
- TouchOSC side needs no scripting: a toggle button with address `/vtr/rec` sends the command when touched and updates its display from the echoed `/vtr/rec` — send and receive sharing one address is exactly TouchOSC's model.

### Sync query API (unix socket, JSON Lines)

Same style as the tap's control API. Requests:

- `{"cmd":"load","path":"…","triggers":["/kick","/note/*"]}` — load a session; trigger patterns come from the client (tox parameter / editor project config). Replies with duration, routes, event/address counts.
- `{"cmd":"resolve","t":12.34}` — per-frame pull. The server keeps **per-connection** previous-t state and returns the delta, mirroring `Resolver.step`: `{"ok":true,"mode":"pump"|"seek","events":[[port,"/addr",[args]],…]}`. Events in a `resolve` reply are *returned, not emitted* — pull clients apply them locally; only the push transport emits UDP. A new connection starts with a full catch-up (`mode:"seek"`).
- `{"cmd":"status"}` — loaded file, playhead, transport state, connection count.

Client contract (TD tox): blocking call in `onFrameStart` with a small timeout budget (~2 ms). On timeout, apply nothing (state freezes on the last applied values); after N consecutive failures, surface the degraded state in the tox UI and stop querying until the player responds to a background probe. Values must be **applied synchronously** (written into a table/CHOP the project reads) — re-injecting via loopback OSC would land a frame late and void the whole point of pulling.

## Resolver semantics (carried over from v1 + agreed follow-ups)

- Continuous forward (`pump`): every event in `(prev, pos]` in order, full fidelity, **no dedup** (repeated identical values are meaningful to arrival-sensitive receivers), triggers fire.
- Jump / backward / first query (`seek`): per-address catch-up to the last event ≤ pos, coalesced to one message per address, restricted to touched addresses when prev is known, triggers suppressed. Addresses with no event ≤ pos stay silent.
- **Snapshot dedup on seeks**: skip catch-up emissions equal to the per-connection last-emitted value. Exact float equality only — no epsilon (archival fidelity).
- Trigger patterns: OSC-style address patterns, supplied at `load`.

## Component impact

- **osc-tap**: `/vtr` parsing + relay on listen sockets; 10012 removal; control API `start` gains the optional `tl` the OSC path has. e2e tests + README protocol section updated.
- **vtr-player**: new crate (likely a sibling binary in the osc-tap workspace). Resolver ported from `td/src/vtr_core`; the 16 pytest cases are translated into Rust tests as the conformance suite (the Python originals stay as the executable reference).
- **osc-editor**: spawns/monitors the player next to the tap; control-port setting replaced by echo-port; recording status unchanged (tap wait API). Its preview can later delegate to the player (follow-up).
- **TD tox**: Rec page now targets the listen port with `/vtr/…` addresses. Play page becomes a sync-query client: `File` calls `load`, per-frame `resolve` fills an output table/CHOP. The local Python player path is removed once this lands; how existing OSC-in-wired TD projects migrate to reading the tox output (or accept the 1-frame-late loopback option) is decided during tox rework.
- **Other apps**: Resolume/VDMX/Unity need nothing installed — TouchOSC (or any controller) drives `/vtr/rec`, transport (`/vtr/play` / `/vtr/stop` / `/vtr/seek`) comes from the editor or a custom app, and the player pushes OSC to the app's input port.

## Out of scope / future

- Group-latch catch-up category for clip-launch protocols (Resolume `/connect`: replay only the last launch per layer group). Needed for serious Resolume support; requires a pattern→group-key config.
- Ableton Link / SMPTE-to-`/vtr/clock` bridge for apps without a timeline.
- SQLite session format with baked snapshots (escalation path from the td spec).
- Deterministic non-realtime rendering (the sync query API is the foundation; needs TD-side apply + non-realtime pacing).
- Editor preview delegating to vtr-player (single resolver everywhere).

## Open questions

- Default degraded-mode behavior on the TD side beyond freezing (e.g. auto-switch to live input) — revisit with real stage experience.

Resolved 2026-07-20 (decisions folded into the sections above): player internal ports/paths (relay `127.0.0.1:10013`, `vtr-player.sock` in dataDir, no launchd), mixed-bundle handling (consume whole, drop non-`/vtr` siblings), echo expiry (3 min) + initial rec-state echo on first contact, `/vtr/clock` multi-sender arbitration (last-write-wins + warning). Revised later the same day after correcting the TouchOSC feedback model (send/receive share one address per control): `/vtr/pos` dropped entirely, echo reduced to rec state, controller-facing `/vtr/rec <0|1>` toggle added, no transport/seek UI on controllers.
