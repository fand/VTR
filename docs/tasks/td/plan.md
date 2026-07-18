# Plan: TouchDesigner component (vtr.tox)

Status: steps 1–4 & 6 implemented (2026-07-18); step 5 (manual verification in TD, which also generates and commits `vtr.tox`) pending — checklist in `td/README.md`. Spec: [spec.md](spec.md).

## Shape

1. `td/src/vtr_core`: pure-Python session loader + playback resolver, pytest-covered, no TD imports.
2. `td/src/vtr_ext.py`: TD extension wiring parameters, clock/rec OSC, and the per-frame cook to the core.
3. `td/build/build_vtr.py`: script run inside TD that generates `vtr.tox` from `src/`, so the tox is reproducible instead of hand-maintained.
4. Manual verification against real osc-tap + editor, checklist in `td/README.md`.
5. CI job for the pytest suite; top-level docs.

## Steps

### 1. vtr_core: session model (`td/src/vtr_core/session.py`)

- `Session.load(path)` — streaming JSONL parse. Header line → `routes: dict[listen_port → forward_port]`; `session_end` → `duration`; event lines → columns.
- Columns per spec: `t` float64, `addr_id` int32, `arg_off`/`arg_len` int32 into a shared float64 `argpool`; events whose `types` contain non-float tags go into `raw_args: dict[event_index, list]` instead (argpool row left empty).
- Address table keyed by `(port, a)`: `addrs: list[(a, port)]`, and per-address `idx: list[np.ndarray]` of event indices (built in one pass, then converted to arrays).
- Malformed lines: skip and count (`skipped`), never raise mid-file — recordings from the wild must load.
- Tests (`td/tests/test_session.py`): header/routes parsing, arg packing round-trip, mixed-type args fallback, malformed-line tolerance, duration from `session_end` (and fallback to last event `t` when the trailer is missing).
- Tooling: `td/pyproject.toml` (deps: numpy; dev: pytest). Runs with `uv run pytest` or plain venv — no repo-wide impact.

### 2. vtr_core: playback resolver (`td/src/vtr_core/resolver.py`)

- `Resolver(session, trigger_matcher, jump_threshold=0.5)`. `trigger_matcher: Callable[[str], bool]` keeps TD's `tdu.match` out of the core; tests pass an `fnmatch`-based one and the extension passes a tdu-based one.
- `step(pos) -> list[Emit]` where `Emit = (port, addr, args)`; internally tracks `prev`.
  - Continuous forward: `searchsorted` the global `t` for `(prev, pos]`, emit in order.
  - Seek (per spec): per-address `searchsorted(t[idx[k]], pos, side='right') - 1`, emit last value per address; skip trigger addresses. Backward step restricts the address set to those with events in `(pos, prev]` (slice of the global columns).
- `reset()` — forget `prev` so the next `step` is a seek (used on file load and transport start).
- Tests (`td/tests/test_resolver.py`): forward pump ordering and boundary inclusivity, forward jump → coalesced catch-up, backward scrub touches only affected addresses, trigger suppression on seek but not on pump, `reset` semantics, empty session / pos before first event.

### 3. TD extension (`td/src/vtr_ext.py`)

- `VTRExt(ownerComp)` with the two parameter pages from the spec (pages created by the build script, not at runtime).
- Rec side, driven by a Parameter Execute DAT + Execute DAT (`frameStart`) inside the comp, both thin shims calling extension methods:
  - `onFrame()`: if `Clock` and `absTime.seconds - last_clock >= 1/Clockrate`, `sendOSC('/clock', [t, rate])` via the control `oscout` DAT; `t = op('/').time.seconds`, `rate = op('/').time.rate if op('/').time.play else 0`.
  - `Record` on → `/rec/start [t, rate]`; off → `/rec/stop`.
- Play side:
  - `File` change → `Session.load` + new `Resolver` (synchronous, per spec), rebuild lazy `oscout` map from routes / `Playhost` / `Playport`.
  - `onFrame()` also computes position (`Locktotimeline` → root timeline − `Offset`; else internal transport advanced by `absTime` delta while `Play`), calls `resolver.step`, sends each emit through the oscout for its mapped port.
  - `Play` off→on and `Rewind` call `resolver.reset()`.
- `sys.path` bootstrapping: the build script embeds `vtr_core` modules as Text DATs inside the tox and imports them via `mod()`, so the shipped tox has no filesystem dependency; during development the DATs are file-synced to `td/src/`.

### 4. Build script (`td/build/build_vtr.py`)

- Run inside TD (textport: `run(.../build_vtr.py)`): creates `/vtr` Base COMP, custom pages/parameters with defaults per spec, control `oscout`, the two exec DATs, file-synced Text DATs for `vtr_ext.py` + `vtr_core/*`, sets the extension, saves `td/vtr.tox`.
- Idempotent: deletes and rebuilds the comp, so spec changes are re-runs, not hand edits.
- `td/README.md`: how to load the tox, how to rebuild it, dev loop (edit .py → re-init extension), plus the manual test checklist from step 5.

### 5. Manual verification (osc-tap + editor)

- Rec: with osc-tap running (editor closed and open), toggle `Record` in TD → clip appears / imports; verify events carry `tl` consistent with the TD timeline (clock beacon) and that `/rec/start` with `t` syncs the first event.
- Play: export a session from the editor, load in the tox → OSC arrives on the forward port (watch with an OSC-in DAT); verify scrub (pause timeline + drag), reverse drag, mid-session start via `Offset`, trigger suppression with a `Triggerpatterns` entry, and that the tap does **not** re-record replayed events while recording is armed.
- Record findings in `td/README.md` checklist checkboxes; anything broken feeds back into steps 1–3.

### 6. CI + docs

- `.github/workflows/ci.yml`: add a `td-tests` job (Linux, setup-python + numpy + pytest, `pytest td/tests`). Cheap, no TD needed.
- `README.md`: add a Components entry for `td/` (what the tox does, pointer to `td/README.md`).
- `TODO.md`: drop the TouchDesigner line.

## Order & scopes

Steps 1–2 are pure TDD and land first (scope: `td` — new conventional-commit scope, e.g. `feat(td): session loader`); 3–4 need TouchDesigner open for iteration; 5 needs osc-tap; 6 last.
