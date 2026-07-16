# osc-mtr

Record, edit, and replay OSC for VJ performance archival. See [spec.md](spec.md).

- **osc-tap** (Rust): UDP proxy that forwards OSC unchanged to TD and logs parsed copies as JSONL. Stamps TD-timeline time (`tl`) from a beacon.
- **osc-editor** (Electron): DAW-style editor. Records clips via osc-tap, arranges them on tracks, previews to TD, exports a merged `session.jsonl`.

## Dev

```sh
# tap
cd osc-tap
cargo test                    # unit + e2e
cargo test --release -- --ignored   # 120Hz soak

# editor (spawns tap from ../osc-tap/target)
cd osc-editor
npm install
npm run dev                   # workdir = cwd
npm run test:e2e              # playwright e2e
RUN_LAUNCHD=1 npx playwright test e2e/launchd.spec.ts   # launchd agent test
```

The editor uses its cwd as the working directory: clips (`clip-*.jsonl`),
`project.json`, and `session.jsonl` all live there.

osc-tap runs as a child process in dev. Packaged builds on macOS run it as a
launchd user agent (`com.osc-mtr.osc-tap`): crash → auto-restart, editor quit →
bootout. Force with `OSC_TAP_SPAWN=launchd|child`.
