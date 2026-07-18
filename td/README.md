# VTR TouchDesigner component

`vtr.tox` speaks osc-tap's control protocol from inside TD (rec start/stop + `/clock` beacon) and replays exported `session.jsonl` files back into the project — including scrubbing, reverse, and mid-session starts. Design: [docs/tasks/td/spec.md](../docs/tasks/td/spec.md).

Requires a TouchDesigner build with Python 3.10+ (numpy is bundled with TD). Defaults match osc-tap's default ports.

## Layout

- `src/vtr_core/` — pure-Python session loader + playback resolver. No TD imports; tested with pytest.
- `src/vtr_ext.py` — the TD extension (parameters, control OSC, per-frame cook).
- `build/build_vtr.py` — regenerates `vtr.tox` from `src/` inside TD.
- `vtr.tox` — the built component (generated; embeds the sources as Text DATs, so it has no filesystem dependency).

## Building the tox

In the TD textport:

```python
exec(open('/path/to/vtr/td/build/build_vtr.py').read())
build('/path/to/vtr/td')
```

This deletes any existing `/vtr` COMP, rebuilds it, and saves `td/vtr.tox`. Dev loop: edit files under `src/`, re-run `build(...)`, retest. Never edit the DATs inside the tox — they are overwritten on every build.

## Tests

```sh
cd td
uv run pytest
```

## Parameters

**VTR Rec** — `Record` sends `/rec/start <t> <rate>` / `/rec/stop` to `Controlhost:Controlport` (default `127.0.0.1:10012`). `Clock` (default on) sends `/clock <t> <rate>` at `Clockrate` Hz; `t` is the root timeline in seconds, `rate` is 0 while paused. The beacon keeps running while paused on purpose — osc-tap drops `tl` stamping when the beacon goes stale.

**VTR Play** — `File` points at an exported `session.jsonl`. With `Locktotimeline` on (default), playback position = root timeline − `Offset`; pause the timeline and drag it to scrub. With it off, `Play` / `Rewind` run an internal transport. `Triggerpatterns` (space-separated address patterns, `tdu.match` syntax) marks one-shot addresses: they fire only during continuous forward playback, never on seek/scrub. Output goes to the **forward** port from the session header's routes (i.e. TD's OSC-in, not the tap's listen port — so the tap never re-records a replay); `Playhost` / `Playport` override the destination.

## Manual test checklist

Rec (osc-tap running):

- [ ] Editor open: `Record` on in TD → clip appears live in the editor; off → clip stops.
- [ ] Editor closed (launchd tap): `Record` on/off → clip imports on next editor launch.
- [ ] Recorded events carry `tl` matching the TD timeline (clock beacon works; pause TD → `rate` 0 in `/clock`).
- [ ] `Record` on while tap is already recording → no error, no duplicate clip (idempotent).

Play (session exported from the editor):

- [ ] Load in `File` → OSC arrives on the forward port (watch with an OSC In DAT).
- [ ] Scrub: pause TD timeline, drag → values follow, coalesced (no event flood).
- [ ] Reverse drag → values return to earlier state.
- [ ] Mid-session start via `Offset` → state catches up at the first frame.
- [ ] `Triggerpatterns` entry → matched address silent while scrubbing, fires on normal playback.
- [ ] Arm recording while replaying → replayed events are **not** re-recorded by the tap.
