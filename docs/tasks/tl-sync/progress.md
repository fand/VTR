# Progress: tl-sync — bidirectional TD/editor timeline sync

Spec: [spec.md](spec.md) · Plan: [plan.md](plan.md) · PR: [#13](https://github.com/fand/VTR/pull/13)

## 2026-07-22 — design discussion → spec + plan

Started from "seek in TD or in the editor, other side follows — no master
switch". Key decisions reached in discussion before writing code:

- Only the **playhead** is synced (a shared clock); OSC delivery keeps its
  existing paths (editor `Preview` push, TD per-frame resolve). Delivery
  unification (TODO's "resolver 一本化") stays orthogonal.
- Loop prevention: origin echo suppression + gen counter, with a
  server-side hold window. An explicit master state machine was rejected —
  last-touched-wins emerges from the origin rules, and TD has no
  scrub-gesture event anyway, so "claim on drag" would reduce to the same
  discontinuity detection.
- "TD でシーク" = the TD **root timeline** (drag); play/pause is in scope;
  offline render (`timeline` mode) is explicitly out — wall-clock sync and
  offline determinism are mutually exclusive.

## 2026-07-22 — plan phases 1–5 implemented

One commit per phase (branch `claude/auto-sync-architecture-ud7j6y`):

| Phase | Commit | Contents |
| --- | --- | --- |
| 1 | `666d971` | transport.rs: `generation`/`origin`/`last_write` on `TState`, hold rule (`accepts()`, 400 ms), sessionless seek (playhead moves with no session; resolve/emit still needs one), `watch()` condvar primitive. 6 unit tests. |
| 2 | `cd07dbc` | control.rs/relay.rs: optional `origin` on `play`/`stop`/`seek`, `gen`+`origin` on every transport reply (`resolve`/`status` included), `watch` long-poll cmd (~1 s server timeout), relay stamps controller `/vtr/*` with origin `osc`. e2e ×3. |
| 3a | `91f6634` | PlayerManager: origin-tagged transport writes, `watch(gen)` with a long-poll-sized timeout, `TransportState` shared type. |
| 3b | `3d16901` | `TransportFollow` loop (echo suppression by origin, timeout skip, error → re-baseline from gen 0) → `transport:update` to the renderer; session residency (inline load on open + debounced after edits); renderer playhead follows foreign moves. vitest ×5. |
| 4 | `9bc99d1` | tox `Positionmode` = `sync`: bidirectional glue in `_sync_tick`, JUMP/DRIFT thresholds, reconnect re-baseline. Builder menu entry. |
| 5 | `9ea5989` | README (transport-authority paragraph, origin column), `td/README.md` (sync mode, checklist item 5), TODO.md, spec/plan status. |

## 2026-07-22 — self-review found 4 issues, all fixed

Adversarial review of the PR diff before hardware verification. Each fix
is one commit:

| Severity | Commit | Issue → fix |
| --- | --- | --- |
| Critical | `c462be1` | **watch head-of-line blocking**: the server handles a connection's lines in order, and PlayerManager shared one socket — an editor seek could wait the full ~1 s watch timeout behind its own long-poll, *and the seek was the change that would have woken it*. Connection handling extracted into a `Channel`; commands and watch now ride separate connections. Regression test asserts a seek resolves while a watch is pending (2 connections). |
| Critical | `bd57117` | **sync-mode detection compared against the transport reply**, so every foreign move looked like a local gesture: a paused editor seek got written back (and *reverted* once the 400 ms hold expired), and entering sync mode pushed TD's stale position to the shared playhead. Now detects against a tracked expected state (`_sync_last` + elapsed, the spec's algorithm), first tick adopts without writing, write replies are folded back in, and a hold-rejected gesture snaps back to the holder's state instead of diverging forever. |
| High | `0c55bf1` + `25613b0` | **residency reload reset the shared transport on every edit** (`load` = stop + rewind + gen bump with origin `""`): TD mid-playback got yanked to 0, the editor's own playhead snapped to 0 via the `""`-origin echo, and booting with no project clobbered a tox-File-loaded session with an empty one. `load` gains `origin` (stamped on the reset's gen bump) and `keep:true` (session swap without touching the transport — epoch reset still gives full catch-up, so edits land mid-playback); editor inline loads use both and skip the empty no-project state. e2e for keep/origin. |
| Moderate | `b795fff` | **foreign transport moves only updated the UI**: a TD seek during an editor preview left the OSC push streaming from the old position, and a TD play created a phantom local playback whose end-of-project auto-pause stopped the shared transport. Foreign seek now repositions the live stream (`preview.seek(t, mirror=false)` — mirroring back would be an echo), foreign play animates the playhead as `remote` (no OSC push — TD gets events via its own resolve — and no auto-pause), foreign stop freezes a running stream. |

`71d2758` updates spec.md to match (load origin/keep, the
watch-needs-its-own-connection rule, remote-playback editor behavior).

Verification in this environment: `cargo test -p vtr-player` (18 unit /
15 e2e incl. hold, watch block/timeout, load keep/origin), editor
typecheck + `test:unit` (84) + lint (0 errors), `py_compile` on
`vtr_ext.py`, `uv run pytest` (16, vtr_core untouched).

## Remaining — tox rebuild + manual verification in TD

Not runnable here (needs TouchDesigner + `./run`):

1. Rebuild `td/vtr.tox` in the TD textport (`build/build_vtr.py`) and
   commit it — the checked-in tox predates the `sync` menu entry.
2. Walk spec.md's manual checklist (editor↔TD both directions, controller
   `/vtr/seek`, no-oscillation, simultaneous drag, pause + scrub, player
   kill/respawn, offline-render regression).
3. Tune `SYNC_JUMP_EPS` (0.25 s) / `SYNC_DRIFT_FRAMES` (2) on hardware —
   spec values are starting points; both are module-level constants.

Known-risk seams (TD-only, unverifiable here): `op('/').time`
`frame`/`play` assignment while paused (heartbeat-path scrub), timeline
`rate` as FPS in the frame mapping, and JUMP_EPS false positives under
frame-rate hiccups (a false write is bounded to one bounce by the hold
rule). Everything protocol-side is covered by the Rust suites.
