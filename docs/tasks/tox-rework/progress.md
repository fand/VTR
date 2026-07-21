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

## 2026-07-21 — editor live-follow (file-less editor → TD)

Decided after the first TD bring-up ("editor 再生で state DAT が動かない"):
the editor must reach TD without an export. Three commits:

| Commit | Contents |
| --- | --- |
| `87224e6` | vtr-player control API: `load` accepts inline `events` (+`name`/`duration`) — no file; `play`/`stop`/`seek` cmds drive the push transport; `resolve {"follow":true}` resolves at the transport playhead (reply carries `t`/`playing`). e2e ×2. |
| `c40f623` | Editor mirrors its preview into the player: `preview:play` inline-loads the merged project (no routes → player transport stays silent, the editor keeps pushing app OSC itself) then seeks + plays; `preview:seek`/`stop` mirror. Best-effort — preview never fails when the player is down. |
| `e23bbb6` | tox: `Positionmode` menu replaces `Locktotimeline` — `timeline` (offline render), `follow` (player transport = editor preview, `File` empty), `internal`. |

Known drift caveat: during preview, TD state comes from the player transport
while app OSC comes from the editor's own pusher — two clocks, so long
previews can drift slightly. Fine for preview; offline render uses the
`timeline` source and is unaffected. Full pusher delegation (player emits
to the app, editor pusher removed) stays a possible follow-up.

## 2026-07-21 — CHOP output

Requested after the first player-mode use ("tox から chop output もしてほしい"):
the state DAT was the only numeric sink, forcing every project through a
DAT-to-CHOP. Added a `chop_out` Script CHOP alongside it — one channel per
numeric OSC argument, latest value held. `VTRExt._apply_chop` folds each
delta's numeric args into a channel map (channel name = OSC address;
multi-arg addresses fan out to `addr:0`, `addr:1`, …; string args skipped)
and force-cooks the Script CHOP when something moved (pull-driven cook is
cached, so a live output must be dirtied). `FillChop` is the `onCook` hook.
Map resets with the state DAT on session load. Builder gains the
`chop_out` scriptCHOP + `chop_callbacks` DAT. README output section and
manual checklist updated. Same TD-only bring-up caveat: not runnable here.

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
