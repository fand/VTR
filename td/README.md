# vtr_core — resolver conformance reference

Pure-Python reference implementation of VTR's playback resolution semantics, with the test suite that defines them. The production resolver will be the Rust `vtr-player` ([docs/tasks/resolver-server/spec.md](../docs/tasks/resolver-server/spec.md)); its implementation must match this one — the tests here are the conformance fixtures to port.

- `src/vtr_core/session.py` — columnar `session.jsonl` loader (numpy columns, per-address indexes, routes/duration, malformed-line tolerance).
- `src/vtr_core/resolver.py` — playback resolver: event pump for continuous forward playback (full fidelity, triggers fire), per-address catch-up for seeks/reverse (coalesced, triggers suppressed).

No TouchDesigner dependency. This directory originally held an in-TD player component (`vtr.tox`); that approach was superseded before release — history in [docs/tasks/td/](../docs/tasks/td/).

## Tests

```sh
cd td
uv run pytest
```
