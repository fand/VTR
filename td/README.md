# td — TouchDesigner component (vtr.tox)

**vtr.tox** — the TouchDesigner client component (protocol v2): a thin,
mode-switched sync client. Source in `src/vtr_ext.py`, generator in
`build/build_vtr.py`.
Playback-resolution semantics live in the Rust resolver and its tests
(`vtr-player/tests/conformance_*.rs`).

## vtr.tox

One Base COMP, one `Mode` switch:

- **record** (realtime, live use): TD follows VTR. When recording starts
  anywhere — the editor, or a controller sending `/vtr/rec/start` — the tap
  notifies the tox (plain OSC on `Notifyport`), and the tox seeks the root
  timeline to `tl` and starts playback. `/vtr/rec/stop` keeps TD playing.
  The tox beacons `/vtr/clock <t> <rate>` to the tap (also while paused,
  rate 0) and the `Record` toggle can start/stop clips from TD.
- **player**: every frame, `onFrameStart` blocks on a resolve query to
  vtr-player's unix socket and applies the returned delta before the frame
  cooks. `Positionmode` picks the position source:
  - `timeline` — TD root timeline − `Offset`. Deterministic by
    construction: two offline exports of the same session produce
    identical frames. This is the offline-render mode.
  - `follow` — the player's push-transport playhead (read-only). The editor
    mirrors its preview into the player (inline load + play/seek), so
    **playing in the editor drives TD live** — no export, no `File`.
  - `sync` — bidirectional glue between the root timeline and the
    transport. A discontinuity between them is read as a user seek and
    written back (origin `td`); foreign moves (editor/controller) drive the
    timeline. So **scrubbing either TD or the editor moves both**. A reconnect
    re-baselines from the transport. Live only — not for offline render.
  - `internal` — the tox's own transport (`Play` / `Rewind`).

  Output lands in the `state` table DAT (one row per address:
  `port addr args…`), the `chop_out` CHOP (numeric channels, see below),
  and the `callbacks` DAT's `onEvents(events)` hook (ordered delta — use
  this for triggers).

  `chop_out` is the numeric sibling of the state DAT: one channel per
  numeric OSC argument, holding its latest value, so you can wire OSC
  numbers straight into TD without a DAT-to-CHOP. Channel name = OSC
  address (`/vtr/foo`); an address carrying more than one numeric arg fans
  out to `/vtr/foo:0`, `/vtr/foo:1`, …. String args have no CHOP form and
  are skipped — read those from the state DAT. Values persist (latest wins)
  and reset on session load; if the same address arrives on two ports, the
  last one applied wins the channel.

  Sync survives a **paused TD timeline**: `onFrameStart` stops firing on
  pause, so a delayed-run heartbeat (~20 Hz) takes over the tick (both the
  player query and record mode's clock beacon) until the timeline plays
  again.

### Parameters

| Page | Parameter | Default | Meaning |
| --- | --- | --- | --- |
| VTR | `Mode` | `record` | `record` / `player` — gates all I/O. |
| VTR Rec | `Record` | off | ON sends `/vtr/rec/start <t> <rate>` (t = root timeline seconds), OFF sends `/vtr/rec/stop`. Idempotent tap-side. |
| VTR Rec | `Clock` / `Clockrate` | on / 10 Hz | `/vtr/clock <t> <rate>` beacon; rate 0 while paused. |
| VTR Rec | `Taphost` / `Tapport` | `127.0.0.1` / 10010 | The tap's listen port (control shares it under `/vtr`). |
| VTR Rec | `Notifyport` | 10014 | Where the tap's `--td-notify` rec notifications arrive. |
| VTR Play | `Sockpath` | `~/Library/Application Support/VTR/vtr-player.sock` | vtr-player control socket (`~` expanded). |
| VTR Play | `File` / `Reload` | — | session.jsonl to `load`. Leave empty when the editor (or another client) loads the session. The player holds ONE global session: loading here swaps it for every client. |
| VTR Play | `Positionmode` / `Offset` | `timeline` / 0 | Position source: `timeline` (root timeline − Offset), `follow` (player transport = editor preview, read-only), `sync` (bidirectional — TD and editor seeks propagate both ways), `internal` (Play/Rewind). |
| VTR Play | `Play` / `Rewind` | — | Internal transport (`Positionmode` = `internal` only). |
| VTR Play | `Triggerpatterns` | — | Space-separated OSC address patterns, matched server-side. |

Degraded behavior (player mode): on a connect failure or query error the
state freezes on the last applied values, the `info` DAT's `error` row
carries the message, and the tox retries the connection every ~1 s. A
reconnect is a fresh player connection — the next resolve is a full
catch-up, and if `File` is set the session is re-loaded automatically (a
restarted player comes back empty).

Player mode needs `AF_UNIX`, which CPython on Windows doesn't expose —
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

1. Rec: Record toggle starts/stops clips with the editor open and closed;
   clips carry `tl` from the clock beacon.
2. Rec follow: recording started from the editor *and* from a controller
   (`/vtr/rec/start <tl>`) both seek TD to `tl` and start playback;
   `/vtr/rec/stop` leaves TD playing.
3. Play: File load surfaces duration/counts in the `info` DAT; timeline
   drag scrubs (forward pump, backward coalesced catch-up); trigger
   addresses fire on forward play only; numeric addresses show up as live
   channels in `chop_out` and clear on reload.
4. Editor follow: with `Positionmode` = `follow` and `File` empty, pressing
   play in the editor moves the `state` DAT in TD; scrubbing the editor
   seekbar scrubs TD; stop freezes it.
5. Sync (bidirectional): with `Positionmode` = `sync`, dragging the TD root
   timeline moves the editor playhead, and scrubbing the editor seekbar
   moves the TD timeline; play/pause propagates both ways; a controller
   `/vtr/seek` moves both. No oscillation after a single seek settles;
   steady playback drives no write-backs.
6. Determinism: two offline exports (Export Movie, non-realtime) of the
   same session produce identical frames; killing vtr-player mid-render
   fails loudly (error row + frozen state) and recovers when it respawns.
7. No re-recording: replay traffic never reaches the tap's listen port.
