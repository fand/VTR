# TODO

From full-app review (2026-07-17). Each task: Problem → Failure → Fix → Test.
Tasks marked **TDD** go red-green: write the failing test first, then fix.
File refs are `osc-editor/src/...` unless prefixed `osc-tap/`.

## Low

- [ ] Clip JSONL drops OSC type tags — record them in osc-tap and use them in
  `main/osc.ts`. NOT preview-only: exported session.jsonl inherits the loss,
  and TD-side replay scripts must guess too. See `docs/tasks/schema/task.md`.
