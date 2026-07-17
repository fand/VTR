# TODO

From full-app review (2026-07-17). Each task: Problem → Failure → Fix → Test.
Tasks marked **TDD** go red-green: write the failing test first, then fix.
File refs are `osc-editor/src/...` unless prefixed `osc-tap/`.

## Low

- [ ] Preview OSC re-encode, proper fix: record OSC type tags in osc-tap's
  JSONL and use them in `main/osc.ts`. The ambiguity is documented in the
  encoder header for now (preview only; export copies JSONL unchanged).
