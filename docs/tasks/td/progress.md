# Progress: TouchDesigner component (vtr.tox)

Spec: [spec.md](spec.md) · Plan: [plan.md](plan.md)

## 2026-07-18 — steps 1–4 & 6 implemented (branch `feat/td`)

One commit per plan step:

| Step | Commit | Contents |
| --- | --- | --- |
| — | `16b0f42` | `td` registered as a conventional-commit scope in CLAUDE.md (spec/plan were committed separately as `chore: plan`). |
| 1 | `b957795` | `vtr_core/session.py` — columnar session.jsonl loader. numpy columns (`t` / `addr_id` / `types_id` / arg offsets) over a shared float64 pool; non-numeric args in a sparse dict; per-address indexes; routes/duration from header/trailer; malformed lines counted, never fatal; defensive re-sort of unsorted input. 8 tests. |
| 2 | `69aa8b2` | `vtr_core/resolver.py` — pump for continuous forward (full fidelity, triggers fire), per-address searchsorted catch-up for first step / forward jumps / backward moves (coalesced, triggers suppressed, only touched addresses when prev state is known). `tdu.match` injected as a callable so the core stays TD-free. 8 tests. |
| 3 | `872466c` | `src/vtr_ext.py` — VTRExt: always-on `/clock` at Clockrate Hz (rate 0 while paused), Record toggle → `/rec/start <t> <rate>` / `/rec/stop`, file (re)load, position from timeline-lock or internal transport, lazy per-forward-port oscout creation via header routes (warns + falls back to the listen port when no route is known). |
| 4 | `4810f41` | `build/build_vtr.py` — idempotent tox generator run in the TD textport (custom pages, control oscout with parameter expressions, sources embedded as Text DATs, exec/parexec shims, extension init, saves `td/vtr.tox`) + `td/README.md` with build steps, parameter docs, and the manual test checklist. |
| 6 | `49814f2` | CI job `td-tests` (ubuntu, uv, pytest); top-level README components/dev sections; TODO updated to point at the remaining verification work. |

Test suite: 16 pytest cases green (`cd td && uv run pytest`), wired into CI.

## Remaining — step 5: manual verification in TD

Not startable from this environment (needs TouchDesigner + osc-tap running). Procedure:

1. In the TD textport: `exec(open('<repo>/td/build/build_vtr.py').read())` then `build('<repo>/td')` — generates `td/vtr.tox`.
2. Walk the manual test checklist in `td/README.md` (rec live/closed-editor, `tl` stamping, scrub/reverse/offset start, trigger suppression, no re-recording of replays).
3. Commit the generated `vtr.tox`.

## Known risks

The TD-facing surfaces are unverified without a TD install; the first `build()` run may need small fixes around:

- `op('/').time.play` / `.rate` member access on the Time object.
- `appendToggle(...)[0]`-style ParGroup indexing and custom-page parameter defaults.
- Parameter Execute DAT parameter names (`op`, `pars`, `valuechange`, `onpulse`) and callback signatures.
- `mod('core_session')` sibling-DAT resolution from the extension DAT.
- `oscout` DAT parameter names (`address`, `port`) and `sendOSC` with an empty arg list (`/rec/stop`).

Everything behind those seams (parsing, indexing, state resolution) is covered by the pytest suite and should not need touching during bring-up.
