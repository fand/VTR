# tox single-mode — drop the record/player Mode switch

The tox's `Mode` switch exists because the implementation diverged from the
design intent. The intent:

- Recording is always triggered from a controller or the editor; TD only
  follows.
- The timeline glue is bidirectional, always. Scrubbing the TD timeline
  mid-take moves the editor playhead and the punch-in backing too — that is
  the user's deliberate gesture, not a failure mode to guard against.
- The generous blocking resolve (5 s timeout) is for offline rendering only.

Under that intent one always-on sync client covers everything, and the
record/player split — plus the whole tap→tox notify path — can go. The tox
needs no rec awareness at all: rec follow arrives as an ordinary foreign
transport move.

## Gaps in the current implementation

1. **Two follow mechanisms, mode-gated.** record mode follows rec via the
   notify port (`--td-notify`, one-shot seek + free-run); player mode
   follows via the push transport. The transport already has punch-in
   priming (`transport.rs prime_seek`), but only the OSC relay triggers it —
   an editor-initiated rec (tap-socket `start`) never primes.
2. **One timeout for two jobs.** `QUERY_TIMEOUT_S = 5.0` protects offline
   renders, but in live sync a hung player stalls the whole TD frame for
   up to 5 s.
3. **Beacon is record-mode-only.** Recording while the tox sits in player
   mode produces clips without `tl` (existing bug, fixed for free here).

## Target design

### vtr.tox

No `Mode`, no `Positionmode` — zero mode concepts. The tox is always both:
clock beacon + sync client. The position source is picked automatically
from TD's realtime flag (`project.realTime`):

- **realtime on (live):** sync — bidirectional glue to the player
  transport, ~100 ms query timeout.
- **realtime off (Export Movie, non-realtime):** resolve at
  `TD timeline seconds − Offset`; the transport is never read or written.
  5 s timeout — renders never skip events. Deterministic by construction.

On a flag edge, `_sync_reset()` (re-adopt the transport on return to
realtime, write nothing).

The old `Positionmode` values map: `timeline` → the realtime-off branch,
`sync` → the realtime-on branch, `follow` ≈ sync when you never touch the
TD timeline, `internal` has no remaining use case.

| Parameter | Meaning |
| --- | --- |
| `Clock` / `Clockrate` | unchanged; the beacon now always runs. |
| `Taphost` / `Tapport` | unchanged (beacon target). |
| `Sockpath`, `File` / `Reload`, `Offset`, `Triggerpatterns` | unchanged. |

Removed: `Mode`, `Positionmode`, `Notifyport`, `Play`, `Rewind`, and the
`oscin_notify` DAT + `OnNotify` + notify callbacks.

Behavior changes:

- **Timeout follows the branch.** Realtime: on timeout, drop the socket,
  freeze state, reconnect on the 1 s throttle — a hung player costs live
  TD one short hiccup, not 5 s per frame. Non-realtime keeps the 5 s
  budget.
- **No rec special-casing.** `_sync_tick` is unchanged: the rec-start seek
  shows up as a foreign transport move (gen bump, origin `rec`) and the
  existing adopt path handles it. Sync stays consistent through a take, so
  no divergence accumulates and no re-baseline edge exists.
- **Rec follow via transport.** Punch-in priming (below) moves the
  transport; TD follows like any other foreign move.

### vtr-player

- **Punch-in moves to the tap event log.** `follow_tap` (echo's tap
  client) already receives `rec_started {clip, tl?}` / `rec_stopped`. On
  `rec_started`:
  - with `tl` and a session loaded: `transport.prime_seek(tl)`, then
    `transport.play("rec")`;
  - without `tl`: `transport.play("rec")` only (matches today's notify
    semantics: start without seeking).

  The play matters: under always-sync the transport is the only thing that
  advances TD, so rec start must start it (the old record mode let TD
  free-run instead). Side effect: a loaded session plays as backing into
  the app during every take — that is the punch-in workflow; record against
  an empty or muted session to avoid it. `rec_stopped` does nothing (the
  transport keeps playing, like today's `/vtr/rec/stop`).

  This covers *every* trigger source — TouchOSC and the editor's
  tap-socket `start` alike — which the OSC-relay path never did. Drop the
  `/vtr/rec/start` arm in `relay.rs` (the relay still registers the origin
  for echo).
- **Rec state stays where it is.** `echo::Inner` keeps it privately for the
  `/vtr/rec` LED echo and mirror suppression (without which replayed values
  would loop back through the tap into the clip). No hoisting, no `"rec"`
  field in control replies — the tox never needs it.

### vtr-tap / vtr-editor

- Remove `--td-notify`, `tap/notify.rs`, and the flag in the editor's
  `tapArgs()` (`tap.ts`). Update the README protocol notes.
- The `/vtr/rec/start|stop|/vtr/rec` OSC handling is untouched.

## Accepted tradeoffs — flag before implementing

- **Rendering requires realtime off.** A render run with realtime left on
  goes through the sync branch and loses determinism. Non-realtime export
  is the standard TD workflow; one line in td/README covers it.
- **Mid-take TD gestures write back.** Dragging the TD timeline (or pausing
  it) during a take moves the editor playhead and the backing. Recorded
  data stays sane — event `t` is clip-relative wall clock, clip placement
  uses the rec-start `tl` — only per-event `tl` goes non-monotonic. Verify
  at implementation time that nothing consumes per-event `tl` as monotonic;
  believed unused beyond diagnostics.
- **Standalone tap loses rec follow.** Today's record mode works with tap
  only (launchd agent, editor closed): the notify port seeks TD directly.
  In the new design rec-follow needs a running vtr-player. With the editor
  open (the normal case) nothing is lost — it spawns both. Standalone tap +
  TouchOSC + TD keeps recording and `tl` stamping, but TD no longer
  auto-seeks on rec start. Accept this (recommended — the standalone rig
  has no session to resolve anyway), or extend the launchd setup to also
  run vtr-player. Decide at implementation time.

## Implementation order

1. player: punch-in (prime + play) from tap events; drop the relay arm.
   (Testable in isolation: fake tap socket in e2e.)
2. tox: single-mode rewrite — beacon always on, notify path deleted,
   position source + timeout branched on `project.realTime`. Rebuild the
   tox in TD.
3. tap + editor: remove `--td-notify` / `notify.rs` / `tapArgs()` flag.
4. Docs: td/README (modes → one section), root README protocol table,
   ARCHITECTURE diagram, manual checklist.

Steps 1–2 must land together before 3 (the tox stops listening before the
tap stops talking; the reverse order breaks rec follow in between).

## Testing

- **player e2e**: `rec_started(tl)` on the fake tap socket primes and
  starts the transport (playhead at `tl`, playing, origin `rec`);
  `rec_started` without `tl` plays without seeking; no priming without a
  session; `rec_stopped` leaves the transport alone.
- **conformance**: untouched — resolution semantics don't change.
- **tox manual checklist** (td/README): rec-follow via transport from both
  trigger sources (TouchOSC and editor); scrubbing TD mid-take moves the
  editor playhead (bidirectional stays on); live hiccup ≤ ~100 ms with a
  SIGSTOPped player while a non-realtime render still blocks; toggling
  realtime mid-session re-baselines without a write-back; two non-realtime
  exports of the same session produce identical frames; clips recorded
  during sync playback carry `tl`.
