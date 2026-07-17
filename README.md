# VTR

VJs' Timeline Recorder. Record, edit, and replay OSC for VJ performance archival.

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
npm run dev                   # optionally: -- path/to/project.oscproj
npm run test:e2e              # playwright e2e
RUN_LAUNCHD=1 npx playwright test e2e/launchd.spec.ts   # launchd agent test
```

Projects are `.oscproj` bundle dirs (`project.json` + `clips/*.jsonl`).
Recordings go into the open project's `clips/`; untitled recordings stage in
userData (`~/Library/Application Support/VTR/recordings/`) and move
into the bundle on save. The control socket and undo log live in userData
too — the editor writes nothing to its cwd.

osc-tap runs as a child process in dev. Packaged builds on macOS run it as a
launchd user agent (`com.fand.vtr.osc-tap`): crash → auto-restart, editor quit →
bootout. Force with `OSC_TAP_SPAWN=launchd|child`.
