# VTR

[![CI](https://github.com/fand/vtr/actions/workflows/ci.yml/badge.svg)](https://github.com/fand/vtr/actions/workflows/ci.yml)

VJs' Timeline Recorder. Record, edit, and replay OSC for VJ performance archival.

## Components

- **osc-tap** (Rust): UDP proxy that forwards OSC unchanged to TD and logs parsed copies as JSONL. Stamps TD-timeline time (`tl`) from a `/tap/timeline` beacon. Default ports: listen 10010, forward 127.0.0.1:10011, beacon 10012.
- **osc-editor** (Electron): DAW-style editor. Records clips via osc-tap, arranges them on tracks, previews to TD, exports a merged `session.jsonl`.

## Quick start

```sh
./run                         # build tap if needed + launch the editor
./run path/to/project.oscproj
```

## Development

```sh
# tap
cd osc-tap
cargo test                    # unit + e2e
cargo test --release -- --ignored   # 120Hz soak

# editor (spawns tap from ../osc-tap/target)
cd osc-editor
npm install
npm run dev                   # optionally: -- path/to/project.oscproj
npm run lint
npm run typecheck
npm run test:unit             # vitest
npm run test:e2e              # playwright e2e (needs osc-tap debug build)
RUN_LAUNCHD=1 npx playwright test e2e/launchd.spec.ts   # launchd agent test
```

CI (GitHub Actions) runs `cargo test` on macOS, plus editor lint / typecheck / unit tests on Linux and the Playwright e2e suite on macOS, for every push to `main` and every pull request.

## Project format

Projects are `.oscproj` bundle dirs (`project.json` + `clips/*.jsonl`).
Recordings go into the open project's `clips/`; untitled recordings stage in
userData (`~/Library/Application Support/VTR/recordings/`) and move
into the bundle on save. The control socket and undo log live in userData
too — the editor writes nothing to its cwd.

## Process model

osc-tap runs as a child process in dev. Packaged builds on macOS run it as a
launchd user agent (`com.fand.vtr.osc-tap`): crash → auto-restart, editor quit →
bootout. Force with `OSC_TAP_SPAWN=launchd|child`.
