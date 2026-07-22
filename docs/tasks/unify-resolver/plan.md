# Plan: unify-resolver — delegate editor preview to vtr-player

Status: landed 2026-07-22 (all phases). One Rust change did prove necessary,
contrary to the estimate below: the emit loop now carries its dedup state
across session swaps, so a residency reload during playback no longer
re-sends values the receivers already hold
(`fix(player): carry emit-loop dedup state across session swaps`).

## Goal

Delete the editor's own preview playback (`osc-editor/src/main/preview.ts`,
a naive event scheduler) and let vtr-player's emit loop send all preview
OSC. One resolver (`vtr-player/src/resolver.rs`, conformance-tested against
`td/tests/`) then serves every playback path: editor preview, file replay,
TD scrubs. Preview becomes WYSIWYG with the final render: same seek
catch-up, same dedup, same pump semantics.

## Current state

- `preview.ts` replays merged events with `setTimeout` + its own UDP
  socket to the forward port. No seek catch-up, no dedup, ignores
  `e.port`, keeps original OSC type tags.
- `index.ts` `preview:play` mirrors into the player *best-effort*
  (`loadInline` keep:true with **no routes**, then seek+play), so the
  player transport moves but emits nothing — the editor pushes OSC itself
  (see the comment on `PlayerManager.loadInline`).
- The player already has everything we need:
  - `load` accepts inline `events` + `routes` override + `keep`
    (`control.rs`).
  - The emit loop (`transport.rs`) resolves `step(playhead)` every 5 ms
    tick and sends to routed ports; a paused seek pushes one resolved
    frame via the seek mailbox.
  - `play`/`stop`/`seek` replies carry the full transport snapshot
    (`playing`, `playhead`, `gen`, `origin`).

So: **no Rust changes**. The work is TS-side rewiring plus docs/tests.

## Key decisions

- **Routes**: build `{port: ports.forward}` for every distinct `e.port`
  in the merged events. Matches old Preview behavior (everything went to
  the forward port, whatever the clip's recorded listen port was).
- **Residency loads carry routes too** (`player:loadInline`). Consequence:
  a foreign (TD/controller) seek or play on an editor session now also
  emits UDP to the forward port — same as the file workflow already does.
  That is the point of one resolver: the player is the only emitter, no
  matter who drives the transport.
- **Keep the `preview:*` IPC channel names**; only the implementations
  change. Renderer diff stays small.
- **Renderer trusts the transport reply.** `play`/`seek` can be rejected
  by the hold rule (foreign writer within 400 ms). The old local preview
  played regardless; now the reply snapshot is the truth — the renderer
  adopts it (rejected play = stays paused, user presses again).

## Behavior changes (accepted)

- Preview needs vtr-player up. It is spawned/respawned by the editor
  (~1 s backoff); a failure now surfaces in the error banner instead of
  a silently dead mirror. Recording is unaffected (tap-only).
- Paused scrub now emits catch-up OSC to TD (deduped). Previously
  silent. This is the desired behavior (TODO item 2 asks for exactly
  this dedup-on-scrub semantics).
- Play/seek starts with a resolver seek: one catch-up message per
  address at the playhead, then the pump. The old preview started cold
  from the playhead (state before it never applied).
- OSC type tags are re-derived by the player (`to_osc_args`: numbers →
  Float/Int/Long). The recorded tags are dropped, same as export+replay
  today. Preview and final render now match by construction.
- Emission granularity is the 5 ms emit-loop tick instead of a 2 ms
  lookahead timer. Irrelevant at OSC rates.
- A residency reload during playback (debounced edit) rebuilds the emit
  resolver → one catch-up burst mid-play. Bounded (one msg/address) and
  correct: the edit is reflected immediately.

## Phase 1 — PlayerManager API (TS)

`osc-editor/src/main/player.ts`:

- `loadInline(events, duration, routes)` — pass `routes` through to the
  `load` request. Update the comment (the player now emits; the editor no
  longer pushes preview OSC).
- `play`/`stopTransport`/`seek` return the parsed `TransportState` from
  the reply instead of `void`.
- Tests (`player.test.ts`): routes forwarded on load; transport replies
  parsed; existing cases updated.

Commit: `feat(editor): pass routes on inline load, return transport snapshots`

## Phase 2 — main-process rewiring

`osc-editor/src/main/index.ts`, delete `preview.ts` + `preview.test.ts`:

- Shared helper `routesFor(events, forwardPort)` used by `preview:play`
  and `player:loadInline`.
- `preview:play`: merge → `loadInline(events, duration, routes)` →
  `seek(fromSec)` → `play()`, all awaited; errors propagate to the
  renderer (no more best-effort catch). Return `{duration, transport}`.
- `preview:seek`: `player.seek(t)`; drop the `mirror` flag (there is no
  local stream left to double-apply). Return the transport snapshot.
- `preview:stop`: `player.stopTransport()`; return the reply's
  `playhead` as the frozen position.
- Keep the `preview:error` channel for async player failures.
- `tap:setPorts` needs no extra work: the renderer's residency effect
  already depends on `ports` and reloads with the new routes.

Commit: `feat(editor): delegate preview playback to vtr-player`

## Phase 3 — renderer (App.tsx, preload)

- Preload: drop the `mirror` arg from `preview.seek`.
- Transport-follow `apply`: no local stream to manage — delete the
  `preview.seek(s.playhead, false)` and `preview.stop()` calls; just set
  playhead/playing state. Keep `remote` only to exempt foreign playback
  from auto-pause (unchanged rule).
- `startPreview`: adopt the returned transport snapshot (rejected write →
  stay paused, log it).
- `pausePreview`: freeze the playhead at the stop reply's `playhead`
  (player truth) instead of the locally extrapolated position.
- Playhead animation stays local (startPos/startedAt extrapolation);
  drift against the player over a preview is negligible.

Commit: `refactor(editor): renderer follows player transport for preview`

## Phase 4 — tests + docs

- e2e: `export-preview.spec.ts` (timing/count assertions should pass
  as-is — 5 ms tick fits the 700–1400 ms span window; verify), and
  `ports-seek.spec.ts` (paused scrub now emits — assert or at least not
  break). Both already require the vtr-player debug build.
- `docs/ARCHITECTURE.md` ②: editor no longer sends preview OSC; arrow
  becomes editor → player (inline load + transport) → TD. Port table row
  "editor → TD (プレビュー)" goes away.
- `CLAUDE.md`: "mirrors its preview into the player" → "delegates preview
  playback to the player".
- README: check the preview mention in the editor section.
- Remove the TODO line.

Commit: `docs: preview playback now emitted by vtr-player`

## Follow-ups (out of scope)

- Skip the per-play `loadInline` when residency already holds the same
  `history.seq` (avoids re-serializing big projects on every Space).
- TODO item 2 (extend curve values before the first data point) lands in
  the one resolver and automatically applies to preview.
