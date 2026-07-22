# Spec: OSC record control (`/rec/start`, `/rec/stop`)

Status: implemented (2026-07-17).

## Goal

The VJ app (TD) starts and stops recording over OSC, so a performance can be
captured without touching the editor. Recording must work even when the
editor is dead (launchd mode keeps vtr-tap alive).

## OSC API

vtr-tap accepts two new addresses on the existing beacon port (default
10012), next to `/clock`:

- `/rec/start [tl] [rate]` — start a clip.
  - `tl` (float/double/int, optional): master timeline seconds at this
    moment. When present, vtr-tap updates the beacon state first, then
    starts the clip — one atomic step, so the clip has a correct `tl` from
    its first event. Args mirror `/clock`: `rate` defaults to 1.0.
  - Without `tl`, the clip starts with whatever beacon state exists.
- `/rec/stop` — stop the current clip. No args.

Rules:

- Idempotent: `/rec/start` while recording and `/rec/stop` while idle are
  no-ops (rate-limited log line, no error).
- Bare addresses, no `/vtr` prefix — consistent with `/clock`; the dedicated
  port is the namespace (X32/QLab style).
- Non-finite or non-numeric `tl`/`rate` args: ignore the arg, still
  start/stop (same tolerance as `/clock` parsing).

### Sync semantics

The `tl` arg on `/rec/start` is the **official** sync mechanism. Sending
`/clock` in the same bundle also works mechanically (flatten preserves
order), but the result depends on intra-bundle order, which senders can't
reliably control — so it is not documented as a sync method.

## Recording behavior

- Remote starts record into the default outdir (staging). The editor's
  existing collect-on-save flow moves them into the project bundle.
- `session_start` header gains `tl` (beacon-extrapolated timeline seconds at
  clip start) when known.

## Control transport: event log + long-poll

How the editor learns about remote (and its own) start/stops. Two
independent axes; we chose one point on each:

- **Payload**: event log (ordered transition list), not status snapshots.
- **Transport**: long-poll on the existing control socket, not push and not
  a fixed-interval poll.

### Protocol

- vtr-tap keeps a ring buffer of events with a monotonically increasing
  `seq`. Events: `rec_started {clip, tl?}`, `rec_stopped {clip}` — an
  extensible envelope; future types (e.g. `beacon_lost`) are new variants.
  Local (control-socket) and remote (OSC) start/stops emit the same events.
- New control command: `{"cmd":"wait","since":N}`. Blocks until an event
  with seq > N exists (or a server-side timeout), then replies
  `{"ok":true,"seq":M,"events":[...]}` (empty on timeout).
- If `N` is no longer in the buffer (overflow, or vtr-tap restarted and seq
  went backwards), the reply carries `"reset":true` plus a full status
  snapshot; the editor re-baselines from it.
- `status` gains `rec_t` (seconds since clip start) and `last_clip` (most
  recently finished clip), used by the snapshot path and the display poll.
- The editor keeps one `wait` outstanding at all times and re-issues on
  reply/timeout. All recording UI state is driven by events — local
  commands (`start`/`stop`) just fire and report errors. The 1s status poll
  stays for display only (beacon, drops, write_error banner).

### Why event log (payload axis)

- Transitions are delivered, not inferred. With status snapshots the editor
  must diff consecutive states, which needs baseline handling, dedupe
  against its own actions, and race guards — an always-on, bug-prone
  reconcile. With events, steady state is plain ordered handlers;
  reconcile shrinks to one snapshot-apply function that runs only at
  connection boundaries (first connect, reset).
- A fast start+stop is two events, never coalesced away.
- Single import path: local and remote stops import clips through the same
  event handler.
- Extensible: adding a message type = one enum variant + one editor handler,
  regardless of transport.

### Why long-poll (transport axis)

- Editor side is nearly free: `wait` is an ordinary request, reusing the
  existing id-match / timeout / reconnect plumbing. Push needs a second
  connection (or unsolicited lines on the shared one), subscribe
  re-establishment, and its own lifecycle code.
- Liveness is built in: timeout → re-issue → connection error falls into
  the existing reconnect path. A push stream can't distinguish "quiet" from
  "dead" and needs heartbeats — mandatory once the transport becomes TCP
  (Windows), where half-open connections are real.
- Tap side stays thin: no subscriber registry, no dead-subscriber cleanup,
  no slow-consumer buffering policy. A `wait` is self-contained.
- Gap recovery rides the same `seq` mechanism as the normal path — events
  missed between two waits are simply returned by the next one.
- If multiple consumers ever appear (external monitors), a `subscribe` cmd
  can be added on top of the same log — an addition, not a rewrite.

### Windows note

The control socket is a unix domain socket today; Node has no AF_UNIX on
Windows, so the future Windows transport is localhost TCP or a named pipe.
Keep `control.rs::serve` generic over `Read + Write` streams so that swap
is small. Long-poll's timeout-based liveness is what makes TCP safe there.

## Rejected alternatives

- **State-style `/rec 1|0`**: TD OSC Out CHOP-friendly (toggle export, no
  script), but the bang form is explicit, has unambiguous per-address args,
  and matches the TODO intent. Fixed on bang-only.
- **`/vtr/` prefix**: no collision risk on a dedicated port; would force a
  `/vtr/clock` alias for consistency.
- **Separate control port**: config surface for no gain.
- **Handling `/rec` on the listen port (10010)**: those packets are
  forwarded to TD and recorded into clips.
- **Editor-mediated start** (tap only reports, editor calls start): breaks
  when the editor is dead and adds poll latency to the capture start.
- **1s-poll reconcile** (status-snapshot payload): ≤1s UI lag and the
  always-on diff/dedupe/race logic described above.
- **Push events (naive A)**: same event-log payload, worse transport —
  second connection, heartbeat requirement on TCP, subscriber lifecycle on
  the tap side.
- **Filesystem watching**: heuristic (tail clips for `session_end`),
  platform-divergent watch semantics, depends on tap flush details.
- **UDP events to the editor / parsing tap stderr**: lossy or unavailable
  in launchd mode.
