# td — TouchDesigner component (vtr.tox)

**vtr.tox** — the TouchDesigner client component (protocol v2): a thin sync
client with no modes. Source in `src/vtr_ext.py`, generator in
`build/build_vtr.py`.
Playback-resolution semantics live in the Rust resolver and its tests
(`vtr-player/tests/conformance_*.rs`).

## vtr.tox

One Base COMP. Every frame it does the same two things:

- **clock beacon** — send `/vtr/clock <t> <rate>` to the tap's listen port so
  recorded events carry TD-timeline time (`tl`). Sent while paused too
  (rate 0). The `Clock` toggle gates it.
- **player tick** — `onFrameStart` blocks on one `resolve` query to
  vtr-player's unix socket and applies the returned delta before the frame
  cooks.

The tox never triggers recording; that comes from a controller or the
editor.

### Position source

Picked automatically from TD's realtime flag (`project.realTime`) — there is
no mode parameter.

| `project.realTime` | Position | Timeout | Transport |
| --- | --- | --- | --- |
| on (live) | bidirectional sync with the player's push transport | ~100 ms | read and written |
| off (Export Movie) | `t` = TD root timeline seconds − `Offset` | 5 s | untouched |

- **Live (realtime on).** A discontinuity between the timeline and where the
  tox expects it to be is read as a user seek and written back (origin
  `td`); foreign moves (editor, controller) drive the timeline. So
  **scrubbing either TD or the editor moves both**. Rec follow arrives the
  same way: vtr-player primes and starts its transport when a take starts,
  and TD follows it like any other foreign move. Short timeout — a hung
  player costs one hiccup, not a stalled frame.
- **Render (realtime off).** Deterministic by construction: two offline
  exports of the same session produce identical frames. The long timeout
  means a render never skips a frame's events. **Render with realtime off** —
  a render run with realtime left on goes through the sync branch and loses
  determinism.

On a flag edge the sync baseline is dropped: returning to realtime re-adopts
the transport and writes nothing.

Sync survives a **paused TD timeline**: `onFrameStart` stops firing on pause,
so a delayed-run heartbeat (~20 Hz) takes over the tick (both the player
query and the clock beacon) until the timeline plays again.

### Outputs

Output lands in the `state` table DAT (one row per address:
`port addr args…`), the `chop_out` CHOP (numeric channels, see below), and
the `callbacks` DAT's `onEvents(events)` hook (ordered delta — use this for
triggers).

`chop_out` is the numeric sibling of the state DAT: one channel per numeric
OSC argument, holding its latest value, so you can wire OSC numbers straight
into TD without a DAT-to-CHOP. Channel name = OSC address (`/vtr/foo`); an
address carrying more than one numeric arg fans out to `/vtr/foo:0`,
`/vtr/foo:1`, …. String args have no CHOP form and are skipped — read those
from the state DAT. Values persist (latest wins) and reset on session load;
if the same address arrives on two ports, the last one applied wins the
channel.

### Parameters

| Page | Parameter | Default | Meaning |
| --- | --- | --- | --- |
| VTR Clock | `Clock` / `Clockrate` | on / 10 Hz | `/vtr/clock <t> <rate>` beacon; rate 0 while paused. |
| VTR Clock | `Taphost` / `Tapport` | `127.0.0.1` / 10010 | The tap's listen port (control shares it under `/vtr`). |
| VTR Player | `Sockpath` | `~/Library/Application Support/VTR/vtr-player.sock` | vtr-player control socket (`~` expanded). |
| VTR Player | `File` / `Reload` | — | session.jsonl to `load`. Leave empty when the editor (or another client) loads the session. The player holds ONE global session: loading here swaps it for every client. |
| VTR Player | `Offset` | 0 | Subtracted from the TD timeline in the realtime-off branch; added to the transport playhead in sync. |
| VTR Player | `Triggerpatterns` | — | Space-separated OSC address patterns, matched server-side. |

Degraded behavior: on a connect failure or query error the state freezes on
the last applied values, the `info` DAT's `error` row carries the message,
and the tox retries the connection every ~1 s. Live, that costs one ~100 ms
hiccup per frame until the retry throttle kicks in; recording and forwarding
are unaffected. A reconnect is a fresh player connection — the next resolve
is a full catch-up, and if `File` is set the session is re-loaded
automatically (a restarted player comes back empty).

The player client needs `AF_UNIX`, which CPython on Windows doesn't expose —
macOS only for now.

### Building the tox

Needs a TouchDesigner install. In the textport:

```python
exec(open('/path/to/vtr/td/build/build_vtr.py').read())
build('/path/to/vtr/td')
```

Idempotent: rebuilds `/vtr` from `src/vtr_ext.py` (embedded as a Text DAT)
and saves `td/vtr.tox`.

### Manual verification checklist (needs TD + `./run`)

1. Rec follow: recording started from the editor *and* from a controller
   (`/vtr/rec/start <tl>`) both seek TD to `tl` and start playback (via the
   player transport); `/vtr/rec/stop` leaves TD playing.
2. Bidirectional sync: scrubbing the TD root timeline mid-take moves the
   editor playhead, and scrubbing the editor seekbar moves the TD timeline;
   play/pause propagates both ways; a controller `/vtr/seek` moves both. No
   oscillation after a single seek settles; steady playback drives no
   write-backs.
3. Hiccup: `SIGSTOP` vtr-player while realtime is on — TD stalls ≤ ~100 ms
   per frame, the `error` row is set, and it recovers on `SIGCONT`.
   Recording and forwarding keep working throughout.
4. Determinism: with realtime off, resolve blocks (up to 5 s) and two
   exports (Export Movie, non-realtime) of the same session produce
   identical frames. Toggling realtime back on re-adopts the transport
   without a write-back.
5. `tl` stamping: clips recorded during sync playback carry `tl` (the beacon
   always runs).
6. Play: File load surfaces duration/counts in the `info` DAT; timeline drag
   scrubs (forward pump, backward coalesced catch-up); trigger addresses
   fire on forward play only; numeric addresses show up as live channels in
   `chop_out` and clear on reload.
7. No re-recording: replay traffic never reaches the tap's listen port.
