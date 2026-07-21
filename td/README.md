# td — TouchDesigner component (vtr.tox) + resolver conformance reference

Two things live here:

- **vtr.tox** — the TouchDesigner client component (protocol v2): a thin,
  mode-switched sync client. Source in `src/vtr_ext.py`, generator in
  `build/build_vtr.py`. Spec: [docs/tasks/tox-rework/](../docs/tasks/tox-rework/).
- **vtr_core** — pure-Python reference implementation of VTR's playback
  resolution semantics, with the test suite that defines them. The
  production resolver is the Rust `vtr-player` (`osc-tap/vtr-player/`); the
  tests here are the conformance fixtures, ported 1:1 to
  `osc-tap/vtr-player/tests/`. The tox does **not** use vtr_core.

## vtr.tox

One Base COMP, one `Mode` switch:

- **record** (realtime, live use): TD follows VTR. When recording starts
  anywhere — the editor, or a controller sending `/vtr/rec/start` — the tap
  notifies the tox (plain OSC on `Notifyport`), and the tox seeks the root
  timeline to `tl` and starts playback. `/vtr/rec/stop` keeps TD playing.
  The tox beacons `/vtr/clock <t> <rate>` to the tap (also while paused,
  rate 0) and the `Record` toggle can start/stop clips from TD.
- **player** (offline rendering): every frame, `onFrameStart` blocks on a
  `{"cmd":"resolve","t":…}` query to vtr-player's unix socket and applies
  the returned delta before the frame cooks. Deterministic by construction:
  two offline exports of the same session produce identical frames. Output
  lands in the `state` table DAT (one row per address: `port addr args…`),
  the `callbacks` DAT's `onEvents(events)` hook (ordered delta — use this
  for triggers), and optionally as re-emitted OSC (`Emitosc`, one frame
  late, migration aid only).

### Parameters

| Page | Parameter | Default | Meaning |
| --- | --- | --- | --- |
| VTR | `Mode` | `record` | `record` / `player` — gates all I/O. |
| VTR Rec | `Record` | off | ON sends `/vtr/rec/start <t> <rate>` (t = root timeline seconds), OFF sends `/vtr/rec/stop`. Idempotent tap-side. |
| VTR Rec | `Clock` / `Clockrate` | on / 10 Hz | `/vtr/clock <t> <rate>` beacon; rate 0 while paused. |
| VTR Rec | `Taphost` / `Tapport` | `127.0.0.1` / 10010 | The tap's listen port (control shares it under `/vtr`). |
| VTR Rec | `Notifyport` | 10014 | Where the tap's `--td-notify` rec notifications arrive. |
| VTR Play | `Sockpath` | `~/Library/Application Support/VTR/vtr-player.sock` | vtr-player control socket (`~` expanded). |
| VTR Play | `File` / `Reload` | — | session.jsonl to `load`. The player holds ONE global session: loading here swaps it for every client. |
| VTR Play | `Locktotimeline` / `Offset` | on / 0 | Queried position = root timeline seconds − Offset. |
| VTR Play | `Play` / `Rewind` | — | Internal transport when the lock is OFF. |
| VTR Play | `Triggerpatterns` | — | Space-separated OSC address patterns, matched server-side. |
| VTR Play | `Emitosc` / `Playhost` / `Playport` | off | Legacy re-emit to the project's OSC-in (routes from the load reply; Playport overrides). |

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
   addresses fire on forward play only.
4. Determinism: two offline exports (Export Movie, non-realtime) of the
   same session produce identical frames; killing vtr-player mid-render
   fails loudly (error row + frozen state) and recovers when it respawns.
5. No re-recording: replay traffic never reaches the tap's listen port.

## vtr_core

- `src/vtr_core/session.py` — columnar `session.jsonl` loader (numpy
  columns, per-address indexes, routes/duration, malformed-line tolerance).
- `src/vtr_core/resolver.py` — playback resolver: event pump for continuous
  forward playback (full fidelity, triggers fire), per-address catch-up for
  seeks/reverse (coalesced, triggers suppressed).

No TouchDesigner dependency.

### Tests

```sh
cd td
uv run pytest
```
