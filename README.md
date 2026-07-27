# VTR

[![CI](https://github.com/fand/vtr/actions/workflows/ci.yml/badge.svg)](https://github.com/fand/vtr/actions/workflows/ci.yml)

VJs' Timeline Recorder. Record, edit, and replay OSC for VJ performance archival.

## Components

- **vtr-tap** (Rust): UDP proxy that forwards OSC unchanged to TD and logs parsed copies as JSONL. Control messages arrive on the listen port under the `/vtr` prefix: `/vtr/clock` stamps TD-timeline time (`tl`), `/vtr/rec*` starts/stops clips, and every `/vtr/*` datagram is relayed to vtr-player. Default ports: listen 10010, forward 127.0.0.1:10011, relay 127.0.0.1:10013.
- **vtr-player** (Rust, `vtr-player/`): resolver server. Replays a `session.jsonl` to the VJ app (push transport driven by relayed `/vtr/play|stop|seek`), answers per-frame sync queries over a unix socket (for TD), primes punch-in state, and feeds controllers back at `target IP : echo port` — rec state plus the playback values themselves, so faders follow the timeline. Protocol: "OSC control" below.
- **vtr-editor** (Electron): DAW-style editor. Records clips via vtr-tap, arranges them on tracks, exports a merged `session.jsonl`. Spawns and monitors both vtr-tap and vtr-player, and delegates preview playback to the player (inline session load with routes + transport writes) — the player's resolver emits all preview OSC, so preview and replay behave identically, and sync clients follow the same transport.
- **vtr.tox** (TouchDesigner, `td/`): mode-switched sync client. `record` follows VTR — the tap's rec notifications (`--td-notify`, default 127.0.0.1:10014) seek TD's timeline and start playback, while the tox beacons `/vtr/clock` back. `player` blocks each frame on a `resolve` query to vtr-player and applies the delta before the cook; position source is the TD timeline (deterministic offline rendering), the player transport (`follow` — tracks the editor preview live, no export needed), or bidirectional `sync` (seeking in TD or the editor propagates both ways). Build & docs: `td/README.md`.

## Quick start

```sh
./run                         # build tap if needed + launch the editor
./run path/to/project.oscproj
```

## Development

```sh
# tap + player (one cargo workspace at the repo root)
cargo test                    # unit + e2e + conformance, both crates
cargo test --release -- --ignored   # 120Hz soak

# editor (spawns tap + player from ../target)
cd vtr-editor
npm install
npm run dev                   # optionally: -- path/to/project.oscproj
npm run lint
npm run typecheck
npm run test:unit             # vitest
npm run test:e2e              # playwright e2e (needs vtr-tap debug build)
RUN_LAUNCHD=1 npx playwright test e2e/launchd.spec.ts   # launchd agent test
```

CI (GitHub Actions) runs `cargo test` on macOS, plus editor lint / typecheck / unit tests on Linux and the Playwright e2e suite on macOS, for every push to `main` and every pull request.

## Project format

Projects are `.oscproj` bundle dirs (`project.json` + `clips/*.jsonl`).
Recordings go into the open project's `clips/`; untitled recordings stage in
userData (`~/Library/Application Support/VTR/recordings/`) and move
into the bundle on save. The control socket and undo log live in userData
too — the editor writes nothing to its cwd.

## OSC control (protocol v2, `/vtr` namespace)

Control messages share the listen ports with app traffic under the
reserved `/vtr` prefix. They are never forwarded to the app and never
recorded; each one is also relayed (with its origin) to vtr-player.
A bundle counts as control if it contains at least one `/vtr/*` message;
its non-`/vtr` siblings are dropped, so don't mix them in one bundle.

| Address | Args | Handled by | Effect |
| --- | --- | --- | --- |
| `/vtr/clock` | `t [rate]` | tap | Timeline beacon for `tl` stamping. `t` = master timeline seconds, `rate` = speed (default 1; 0 = paused). Send at ~10Hz; recorded events get an extrapolated `tl`, omitted once the last beacon is >5s old. |
| `/vtr/rec` | `0\|1` | tap | Controller-facing rec toggle: `1` starts a clip (no beacon seed), `0` stops it. The player echoes the same address back on state change. |
| `/vtr/rec/start` | `[tl] [rate]` | tap + player | Start a clip. The optional `tl` updates the clock and starts the clip in one step, so the recording is synced from its first event — this is the official sync mechanism. The player additionally primes punch-in state at `tl`. |
| `/vtr/rec/stop` | — | tap | Stop the clip. |
| `/vtr/play` / `/vtr/stop` | — | player | Push-transport run/pause (origin `osc`). |
| `/vtr/seek` | `t` | player | Jump the push transport to `t` (origin `osc`). |
| `/vtr/echo` | `0\|1` | player | Pause/resume the playback-value mirror (global). `1` also mirrors every address's value at the playhead once — a full sync, like a seek's catch-up — even when the mirror was already on. Control feedback — `/vtr/rec` and the `/vtr/echo` confirmation itself — keeps flowing, so toggle buttons stay in sync. Back on after a player restart. |
| `/vtr/origin` | — | player | Internal to the tap→player relay: tells the player a host is talking to us, so it can feed that host back. Never sent by a controller. |

All rec commands are idempotent: start-while-recording and stop-while-idle
are no-ops. Non-numeric or non-finite args are ignored (the command still
runs). Unknown `/vtr/*` addresses are dropped with a rate-limited log.

## Controller feedback (echo port)

Everything the player sends back goes to `target IP : echo port` (default
9000). Targets are found two ways, and the editor header sets both:

- **auto** — a host becomes a target as soon as it sends anything: `/vtr/*`
  registers it directly, and for plain app traffic the tap announces the
  source IP as `/vtr/origin` (once per IP per minute), so a controller with
  no `/vtr` button still gets feedback. Targets live until vtr-player
  restarts (the editor restarts it on relaunch and on echo settings
  changes); a host quiet for 3 minutes is re-greeted with the current state
  on its next contact, in case it restarted meanwhile.
- **pinned** — the `to` field (`--echo-host`) names one host that is always
  a target, even across player restarts before it says anything. Leave it
  empty for auto only. IP literals only; hostnames are not resolved.

Two kinds of message go out:

- control state — `/vtr/rec 0|1` and `/vtr/echo 0|1` on every change, and
  once on first contact from a target, so REC and echo-toggle buttons show
  the truth however the state changed.
- the resolved playback values, mirrored as they are emitted, so faders
  and XY pads follow the timeline during preview and replay. Coalesced per
  address and flushed at 50Hz. Silent while recording (the mirror would
  come back in through the tap and land in the clip) and while toggled off
  with `/vtr/echo 0`. `/vtr/echo 1` mirrors the full state once (every
  address at the playhead), so a controller that sat out catches up — or
  can request a sync any time by re-sending `1`.

TouchOSC note: leave each control's own `Feedback` flag off (the default).
It makes TouchOSC re-send values it receives, which turns the mirror into
a loop.

The push transport is the single authoritative playhead: the editor and
the TD tox (`Positionmode` = `sync`) both read and write it, so a seek or
play/stop from either side — or a controller's `/vtr/*` — propagates to
the others. Each write carries an `origin` and bumps a generation counter
`gen`; a follower applies a change only when `gen` moved and the origin is
not its own (echo suppression), and concurrent writers are arbitrated by a
short hold window (last-touched wins).

With `--td-notify <addr>` the tap additionally reports every rec state
change — regardless of initiator — as plain unwrapped OSC to that address:
`/vtr/rec/start <tl> <rate>` (args omitted when the clock is unknown) and
`/vtr/rec/stop`. This drives the tox's record-mode follow (seek + play);
the editor enables it at `127.0.0.1:10014`.

The editor talks to vtr-tap over a unix-socket JSON Lines API:
`start` (optional `tl`/`rate`) / `stop` / `status`, plus `wait` — a
long-poll on the recording event log (`rec_started` / `rec_stopped`) that
drives the editor's UI.

## JSONL schema

Clip and `session.jsonl` event lines share one schema:

```json
{"t":0.5,"tl":12.3,"port":10000,"a":"/fader","types":"ff","args":[0.42,2.0]}
```

- `t` seconds from recording start; `tl` TD-timeline seconds (omitted when
  unknown); `port` listen port; `a` OSC address.
- `types` is the OSC type tag string without the leading `,`: one char per
  `args` element (`f` f32, `d` f64, `i` int32, `h` int64, `s` string,
  `r` color `"#rrggbbaa"`, `I` impulse `"<impulse>"`, `T`/`F` bool, `N` nil).
  Replay scripts should encode by these tags, not by guessing from the JSON
  value. Blob args are dropped at record time (no tag, no value).
- An `h` arg beyond ±2^53 is written as a decimal **string** so JSON parsers
  with f64 numbers can't round it; parse it back via the tag.
- `types` is absent in clips recorded before the field existed and in
  editor-added events; fall back to guessing (`i` if integral, else `f`).

Sessions may also carry bezier **curve lines** (editor-made; recordings are
always discrete events):

```json
{"type":"curve","port":10000,"a":"/fader","arg":0,"types":"ff","args":[0.42,2.0],
 "knots":[{"t":0.0,"v":0.1,"o":[0.15,0.0]},{"t":1.0,"v":0.8,"i":[-0.2,0.05]}]}
```

A curve controls `args[arg]` of one address over the knots' time span.
Consecutive knots span one cubic bezier: `p1 = knot + o`, `p2 = next + i`
(handle offsets `[dt, dv]`; missing handle = linear). Knot `t` is strictly
increasing and handle `dt` stays within its segment (readers clamp). The
player emits the message template `args` with `args[arg]` replaced by the
interpolated value, one sample per resolve step; curves on the same
`(port, a)` with different `arg` merge into one message. Outside its span a
curve extends flat, like discrete data on seek. Players from before this
field skip curve lines (unknown `type`).

Session files wrap events in `{"type":"session_start",...}` /
`{"type":"session_end","t":...}` marker lines. `session_start` carries
`tl` (timeline seconds at clip start) when the clock is known. Clips recorded
by vtr-tap also carry a `{"type":"summary","t":...,"events":N,"dropped":N,"write_errors":N,"write_error":"..."}`
line right before `session_end`: the clip's health at stop time (`write_error`
is omitted when the clip is clean). Readers should skip unknown `type` lines.

## Process model

vtr-tap runs as a child process in dev. Packaged builds on macOS run it as a
launchd user agent (`com.fand.vtr.vtr-tap`): crash → auto-restart, editor quit →
bootout. Force with `VTR_TAP_SPAWN=launchd|child`.
