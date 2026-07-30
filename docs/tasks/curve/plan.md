# Replace with Curve — first-class bezier support (issue #19)

Add a **Replace with Curve** button to the curve editor. Clicking it fits
the closest piecewise cubic bezier to the targeted points and replaces them
with a **curve record** — a new first-class data type carried through the
whole pipeline. The master data (clip edits and exported `session.jsonl`)
holds discrete events *and* bezier curves; vtr-player resolves both into
per-frame discrete OSC for TD.

Issue: <https://github.com/fand/VTR/issues/19>

## Principles

- **Recording stays discrete.** vtr-tap records OSC input as events, always.
  Clip files are immutable; curves never appear in recordings.
- **Curves are edit data.** Conversion happens in the editor; curves live in
  the non-destructive `ClipEdits` overlay and in exported sessions.
- **Master data is dual-mode.** `session.jsonl` carries events and curve
  lines side by side.
- **TD receives discrete values.** The player emits per-frame values: raw
  events where the data is discrete, interpolated samples where it's a
  curve. The TD component is unchanged — both push replay (5 ms tick,
  `transport.rs`) and sync resolve (per-cook, `control.rs`) go through the
  resolver, so interpolation lives in exactly one place.

## Curve representation

A curve controls one `(port, address, argIndex)` over a time span, as a knot
list (DAW-automation style — 1:1 with fitted cubics, friendly to hand
editing later):

```json
{"type":"curve","port":10000,"a":"/fader","arg":0,"types":"ff","args":[0.42,2.0],
 "knots":[
   {"t":0.0,"v":0.10,"o":[0.15,0.0]},
   {"t":1.0,"v":0.80,"i":[-0.2,0.05],"o":[0.2,-0.05]},
   {"t":2.5,"v":0.30,"i":[-0.3,0.0]}
 ]}
```

- Consecutive knots define one cubic segment: `p0 = (t,v)` of the left knot,
  `p1 = p0 + o`, `p2 = p3 + i`, `p3 = (t,v)` of the right knot. `i`/`o` are
  handle offsets `[dt, dv]`; a missing handle means linear toward the
  neighbor.
- `args`/`types` are the message template: an emission is `args` with
  `args[arg]` replaced by the interpolated value. Multiple curves on the same
  `(port, a)` with different `arg` and overlapping spans merge into one
  message per sample.
- Knot `t` is strictly increasing; handle `dt` is clamped so x(u) stays
  monotone (writer enforces, reader clamps defensively).
- In `session.jsonl` it's a `type` marker line — **old players skip unknown
  `type` lines by design**, so forward compatibility is free (they just
  play the curve as silence, since the covered events were deleted).
- In `ClipEdits` the same shape (clip-local `t`) is appended to a new
  `curves?: ClipCurve[]` array. Like `add`, the array is append-only;
  a parallel `curveDel?: Record<number, true>` mirrors `del` so undo/redo
  and the compacted undo log work unchanged.

## Resolver semantics (vtr-player)

Extend the conformance suite first — these rules become
`conformance_session.rs` / `conformance_resolver.rs` cases:

- **Value definition.** For an address+arg at position `pos`, a curve whose
  span contains `pos` defines the value by interpolation. Outside its span a
  curve extends flat (first knot value before, last knot value after) — the
  same rule discrete data already follows on seek.
- **Discrete + curve on one address:** the definition with the latest
  "definition time" ≤ `pos` wins (an event at its `t`; a curve at
  `min(pos, span end)` once `pos ≥ span start`). The editor's conversion
  deletes covered points, so overlap is rare, but the rule keeps mixed
  sessions deterministic.
- **Several curves on one `(port, a, arg)`** (two clips, or two replaces on
  one clip) follow the same rule: latest definition time wins, ties to the
  later line (the newer edit). Before every span the earliest curve's
  flat-left value applies. The editor also carves a new curve's span out of
  overlapping same-arg overlay curves, so overlap survives only across
  clips or hand-edited files.
- **Pump** (continuous playback): per step, recorded events in `(prev, pos]`
  emit as today, then each active curve emits its sample at `pos` — so push
  replay interpolates at the 5 ms tick and sync clients get one sample per
  cook. A synthesized sample identical to the address's previous emission is
  skipped (flat curve regions don't spam 200 Hz duplicates).
- **Seek / catch-up:** per address, resolve to the winning definition at
  `pos` (curve value or last event), one message per address, triggers
  suppressed, existing snapshot dedup applies.
- **Bezier eval:** value-at-time solves x(u) = t per segment (monotone x →
  binary search / Newton, a few iterations).

Implementation: `session.rs` parses curve lines into per-address curve
tables (columnar, alongside `addr_events`); `resolver.rs` consults them in
`pump`/`catchup`; `transport.rs`/`control.rs` are untouched. A new
`curve.rs` owns knot → cubic → eval math.

## Editor

### Convert (the issue's button)

- Button in the curve panel header (Snap / Box / Pencil row; lucide
  `Spline`; `aria-label="replace with curve"`). Enabled when ≥ 3 selected
  points share a `(property, clip)` group, else when a selected property
  has ≥ 3 points; groups are fitted independently per clip.
- Fit: Schneider's least-squares piecewise cubic (Graphics Gems), error
  tolerance in normalized space (`t` by group span, `v` by property range),
  `FIT_ERROR = 0.01` to start. Output cubics map 1:1 onto knots.
- One `commit()` — label `"N points replaced with curve"` — that writes the
  `del` map for the covered points and appends the `ClipCurve`. Undo/redo,
  autosave, and the undo log come free from the doc/patch machinery.
- Multi-arg events: deleting an event removes all its args' points, so the
  handler fits **every numeric arg** of the covered events as its own curve
  (sharing the deleted set), rather than silently dropping sibling data.
- New pure module `src/renderer/src/components/curveFit.ts`
  (+ colocated vitest): `fitCurve(points, maxError): Knot[]` and
  `evalCurve(knots, t): number` (shared with rendering).

### Render & minimal interaction (phase 1)

- `buildProperties` merges curve values into the property list; the canvas
  painter draws curve spans with `bezierCurveTo` (knots as dots, thicker
  when the property is selected). Hit-testing flattens segments to
  polylines and reuses `segDist2`.
- Selecting a curve and pressing delete removes the curve record
  (`curveDel`) — the covered points stay deleted; undo restores both sides.
- e2e hooks: `__curveProps` gains a `curves` count; a new `__curveKnots`
  mirrors `__curvePoints` for knot geometry.

### Curve editing (phase 2, separate PRs)

Knot drag (t/v), handle drag, knot insert/delete, and a "revert to points"
action (resample curve → `add` events + `curveDel`). Not needed to close
#19 but the knot representation is chosen so these are additive.

### Export & preview

- `merge.ts`: map each overlay curve clip-local → timeline time (offset,
  trim), **splitting segments at trim boundaries via de Casteljau** so
  trimmed clips export exactly what's audible; emit curve lines after the
  events (order irrelevant to the loader, but stable output diffs nicely).
- Preview needs no new work: the editor's inline session load
  (`session::from_values`) parses the same lines, and the player's resolver
  is already the only OSC emitter for preview.

## Compatibility

- Sessions: old players skip `type:"curve"` lines (documented behavior);
  new players play old sessions unchanged.
- Edits sidecars: older editors ignore unknown `curves`/`curveDel` keys on
  read but would drop them on the next save — document that opening a
  curve-edited project in an older build loses curves (acceptable:
  single-user project files).
- README: extend the JSONL schema section and the `.oscproj` notes.

## Test plan

- `curveFit.test.ts`: recover a known cubic; noisy ramp within tolerance;
  V-shape splits; monotone knot output; eval round-trip.
- `conformance_session.rs`: curve line parsing, clamping, unknown-line
  compat.
- `conformance_resolver.rs`: pump interpolates per step; flat extension
  before/after span; discrete-vs-curve precedence; seek catch-up + dedup;
  triggers unaffected; multi-arg merge.
- `merge.test.ts`: offset/trim mapping, de Casteljau split at trim edges.
- e2e: dense fixture → select property → click button → `__curveProps`
  shows a curve and fewer points; undo restores; preview smoke test
  asserts interpolated values arrive between knot times.

## Implementation order

1. **Schema + math** — shared types (`shared/types.ts`), README schema,
   `curveFit.ts` + tests. `feat(editor)`
2. **Player** — `curve.rs`, `session.rs` parsing, resolver semantics,
   conformance tests. `feat(player)`
3. **Editor convert + render** — button, commit wiring, canvas rendering,
   `merge.ts` export, e2e. `feat(editor)` — closes #19.
4. **Phase 2 editing** — knot/handle drag, revert to points. Follow-up
   issues.
