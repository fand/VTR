# Progress: vtr.tox — mode-switched sync client

Spec: [spec.md](spec.md) · Plan: [plan.md](plan.md) · PR: [#11](https://github.com/fand/VTR/pull/11)

## 2026-07-21 — plan steps 1–5 implemented

One commit per plan step (branch `claude/touchdesigner-vtr-sync-tox-7lndql`):

| Step | Commit | Contents |
| --- | --- | --- |
| 1 | `28f48db` | osc-tap `--td-notify`: rec-transition OSC (`/vtr/rec/start [tl rate]` / `/vtr/rec/stop`, plain unwrapped) sent from the writer's start/stop path, so socket-API and `/vtr/rec*` initiations behave identically. Unit tests (seeded clock args, no-clock omission, no notify on failed transitions) + e2e covering both initiation paths. |
| 2 | `0f3ea39` | Editor spawns the tap with `--td-notify 127.0.0.1:10014` (`TD_NOTIFY_PORT` in shared types). |
| 3 | `50e5082` | `td/src/vtr_ext.py` — mode-switched extension. record: `OnNotify` seeks the root timeline to `tl` + starts playback (rec/stop keeps playing), clock beacon (rate 1/0, not FPS), Record toggle. player: blocking unix-socket JSON Lines client in `onFrameStart` (5 s safety timeout, ~1 s reconnect throttle), `load` on File/Reload/Triggerpatterns change and on every fresh connection when File is set, delta applied to the `state` table + `callbacks.onEvents` + optional `Emitosc` re-emit through load-reply routes. |
| 4 | `f480db1` | `td/build/build_vtr.py` — idempotent textport generator (Mode menu, Rec/Play pages, oscout_tap, mode-gated oscin_notify + callbacks shim, state/info tables, user callbacks DAT, exec shims, extension init, saves `td/vtr.tox`). `td/README.md` rewritten: tox docs (modes, parameter table, degraded behavior, macOS-only note, build steps, manual checklist) + the vtr_core reference section. |
| 5 | — (this commit) | Top-level README: vtr.tox component entry, `--td-notify` in the OSC control section. This progress file. |

Verification run in this environment: `cargo test` (osc-tap 18 unit / 22 e2e,
vtr-player suites — all green, clippy warnings unchanged from baseline),
editor lint/typecheck/`test:unit` (75 green, warning count unchanged),
`uv run pytest` (16 green, vtr_core untouched).

## Remaining — step 6: manual verification in TD

Not runnable here (needs TouchDesigner + `./run`). Procedure: build the tox
per `td/README.md`, then walk its manual verification checklist. Commit the
generated `td/vtr.tox` afterwards.

Known-risk seams (same class as v1 bring-up, unverified without TD):
`op('/').time` member access (`frame`/`play` assignment for seek+play),
ParGroup indexing in the builder, oscin DAT callback signature/`active`
expr, table DAT auto-sizing on ragged `appendRow`, and blocking
`socket.makefile` reads under TD's Python. Everything protocol-side is
covered by the Rust test suites.
