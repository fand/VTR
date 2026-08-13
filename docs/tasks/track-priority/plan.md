# Track priority — implementation plan

Spec: `spec.md`. Four commits, continuing on `feat/interp` — PR #29
grows to cover curve-interp and track-priority together (the mask
module leans on `clipCurve`'s step handling from that work). Player
untouched (no cargo rebuild).

Settled in review: the ±1e-6 boundary handling stays (self-describing
export beats a resolver tie-break rule); no resume past the masked
clip's own window; timeline-view mask visuals are a follow-up.

## 1. shared mask module

`feat(editor): track mask module`

- New `shared/trackMask.ts` (+ colocated vitest), pure. Both consumers
  (merge.ts in main, buildProperties in renderer) feed it the same
  abstract shape, so it never touches ClipInst/ProjectClip directly.
  - `clipKeys(events, clipEdits, curves, trimIn, trimOut)` → the
    `"${port} ${a}"` keys a clip carries inside its trim (≥1 edited
    event in-window, or a curve overlapping the window).
  - `maskIntervals(tracks)` — input: per track, its unmuted clips as
    `{ start, end, keys }` in timeline space. Output: per track index,
    `Map<key, Interval[]>` — the union of every *lower* track's windows
    for that key, overlapping intervals merged per key.
  - Application helpers (all timeline space):
    - `dropMasked(events, intervals)` — drop an upper track's events
      with `start <= t <= end` for their key (inclusive; the resume
      event below re-asserts the boundary value).
    - `carveKnots(knots, intervals)` — live pieces via `clipCurve` on
      the complement windows. Carve with a ±1e-6 margin (the round6
      grid): the resolver shadows a point at a span *end* forever, so a
      piece ending exactly at a mask start would kill the take's
      boundary event. Pieces that degenerate (<2 knots) drop.
    - `resumeEvent(track material, interval end)` — the upper track's
      resolved value at the mask end (last-def-wins over its own events
      and curve end values), synthesized as one event at
      `round6(end + 1e-6)`:
      - `+1e-6` orders it after the take's own boundary event (merge
        sorts by t; a tie would let the stale side win);
      - **skipped** when a carved curve piece of the same key covers
        that t — the piece resumes exactly by itself, and a synthetic
        event inside its span would violate the curve-interp invariant;
      - **skipped** when no clip window of the upper track contains the
        mask end — punch-out past the clip's end resumes nothing;
      - null when the track has no definition at or before the end.
- Tests: the spec's [0,10]/[2,4] example; per-key scoping (unrelated
  address passes through); port separation (same address, two ports);
  muted clip doesn't mask; three-track stacking (3 masks 1+2, 2 masks
  1); interval union across lower tracks; boundary events at exactly
  mask start/end; resume from a fully-swallowed curve (its end value);
  resume skipped inside a carved right piece; resume skipped past the
  clip's window; trim/offset placement.

## 2. merge applies it

`feat(editor): lower track wins in merge`

- `merge.ts`: two passes. First walk all tracks to place windows and
  collect `clipKeys` per clip → `maskIntervals`. Then flatten as today,
  but per track: `dropMasked` on placed events, `carveKnots` on placed
  curves (after `placeCurve`), push `resumeEvent`s. Duration unchanged
  (muted/masked clips still occupy the timeline).
- `merge.test.ts`: the [2,4] take beats the [0,10] curve (events out,
  curve split into two placed pieces); discrete-over-discrete (upper
  events inside the take's window drop, resume event at end); resume
  ordering vs the take's boundary event (last wins); masked curve
  fully inside the take (deleted + end-value resume); unrelated
  address/port untouched; muted lower clip masks nothing; export of
  the three-track stack.
- Preview and export both go through `mergeProject`, so replay agrees
  for free — no session/player changes.

## 3. curve editor draws the masks

`feat(editor): masked regions in curve editor`

- CurvePanel gets the track list (new prop from App.tsx) and loads
  events for **every** unmuted clip, not just the shown ones — a lower
  track masks even when it isn't displayed. eventsCache already
  dedupes; masks recompute only when placement/mute/edits change.
- `buildProperties` takes the mask intervals plus each shown clip's
  track index; per element:
  - masked points: dropped from the merged path (`els`) like shadowed
    dots, still drawn dimmed, still selectable/editable;
  - masked curve ranges: `PropCurve` keeps its whole knot list
    (selection identities unchanged), but the merged path uses the
    carved pieces; a per-curve masked-range list feeds curvePaint to
    draw those stretches dimmed/dashed. Hit-testing follows the merged
    path, so masked stretches don't win hover (knots still hit).
  - This also closes the standing gap: overlapping curves now show
    which one plays.
- Synthetic resume events are merge-time only — not drawn.
- e2e (`__curvePoints`/`__curveKnots` gain a masked flag): two
  overlapping tracks → upper's points inside the window read masked;
  move the lower clip away → they come back; mute the lower clip →
  no mask.

## 4. docs

`docs: track priority`

- README: track order is semantic (lower wins, newest take lands at the
  bottom), mask key (port, address), boundary/resume behavior, note
  that existing overlapping projects re-export differently (release
  note; no migration).
- Close the loop on `docs/tasks/track-priority/` (plan + any spec
  deltas found while implementing); update TODO if tracked.

## Follow-ups (out of scope)

- Timeline (track view) visual for masked clip regions — this PR only
  dims them in the curve editor.
- Legacy Replace-with-Curve leftovers (carried over from curve-interp).

## Risks / watch items

- **Boundary shadow rule**: the resolver shadows points at span ends
  *forever* (`unshadowedPoints` pins it). All three ±1e-6 choices in
  commit 1 exist to keep take boundary events and synthetic resumes out
  of curve spans — a unit test per case, not assumption.
- **Sort ties in merge**: events sort by t only (stable). The resume
  event's +1e-6 sidesteps the tie; keep round6 from re-colliding them
  (test pins it).
- **Resume value source**: "latest masked definition" = the track's
  resolved value at the mask end — events *and* swallowed-curve end
  values. Getting only events wrong-resumes over a masked curve.
- **UI event loading**: all-clips loading is new; big projects hit the
  cache once per clip. Watch first-open latency; masks can pop in after
  load like curves do today.
- **applyEdits before masking**: a t-edit can move an event into or out
  of a mask window — key collection and dropping both run on edited
  events (same order merge already uses).
