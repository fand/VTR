# Curve point interpolation — header editor + const ↔ bezier conversion

The curve panel header gets a value input and an interpolation dropdown for
the selected points. The dropdown converts discrete points into bezier
knots (and back), so a recorded step lane can become a smooth curve point
by point.

## Decisions

- Discrete/hold interpolation is named **`const`** (Blender precedent;
  "fixed" reads as locked, "hold"/"step" are fallback candidates nobody
  picked).
- `const` is representable **inside** a curve via a per-knot step flag
  (option B from the design discussion). No curve splitting, no event
  re-materialization on the reverse conversion.
- Setting a non-const mode on a point makes **both** adjacent segments
  interpolate (neighbors get pulled in / un-stepped).
- **Invariant: a curve's span never contains a live event of its
  (port, address).** Discrete events mid-span are not "shadowed but
  harmless": shadowing is a seek rule; during pump an event fires
  verbatim, and over a step hold the curve's dedup (`group_last`,
  resolver.rs) never re-asserts — the stale value would stick until the
  next knot. So conversion **absorbs** every covered event as a knot, or
  **refuses**. Example: points `[a, b, c]`, select a and c, pick an ease
  mode → one continuous curve `[prev, a, b, c, next]` where b is a plain
  knot — never a curve with event b left inside it.
- The value input ignores the "limit 0–1" header toggle (explicit typing
  beats a drag guard).

## Schema: step segments

`CurveKnot` gains `s?: true` — *the segment leaving this knot is a step*:
the value holds at `v` until the next knot's `t`, then jumps.

```json
{"t":1.0,"v":0.8,"s":true}
```

- **Evaluation.** For `t` in `[k.t, next.t)` the value is `k.v`; at exactly
  `next.t` the next segment applies (the jump lands on the knot, matching
  the existing rule that a boundary `t` belongs to the segment starting
  there).
- **Dead handles.** On a step segment `k.o` and `next.i` mean nothing.
  Writers delete them when setting `s`; readers ignore them.
- `s` on the last knot means nothing (flat extension already holds).
  Writers avoid it; readers ignore it. `deletePoints` must strip `s` from
  a new last knot (today it strips only boundary handles, edits.ts).
- `fitCurve` never emits `s`.
- `clipCurve`:
  - splitting *inside* a step segment inserts the boundary knot with the
    left knot's `v` and `s` — no de Casteljau;
  - splitting inside a *bezier* segment whose **right** knot carries `s`
    must keep that `s` through the `ctrlToKnots` rebuild *and* through
    the interior-knot adoption pass (which today copies only `o`) —
    otherwise a trim drops the hold and exports a ramp.
  - Trim/export (`merge.ts` uses `clipCurve`) then carries steps for free.
- **Compat:** old players ignore the unknown `s` key and play the segment
  as linear — graceful degrade, documented in the README schema section.
  Older editors may drop `s` on save (same caveat as the curves feature).

## Interpolation modes

Per-point, always **derived**, never stored:

| mode | meaning |
| --- | --- |
| `const` | discrete event point, or knot with `s` |
| `linear` | knot, no handles |
| `ease in` | knot, `i` handle only |
| `ease out` | knot, `o` handle only |
| `ease in out` | knot, both handles |

- A side with no segment (first knot's in, last knot's out) doesn't count.
- Dragged handles keep the presence-based label — no "custom" state.

## Header UI

```
value [ 1.0  ]  interpolate [ ease in ▾ ]
```

- Shown whenever the point selection is non-empty (between the tool
  buttons and the zoom controls).
- **value**: number input. All selected equal → that value (`fmt`);
  mixed → empty with `-` placeholder. Enter/blur commits to every
  selected point (event arg patch / knot `v`; handle offsets unchanged),
  Esc reverts. Not clamped by the limit toggle. Edits to several knots of
  one curve chain into **one CurvePatch per curve** (whole-array
  replacement; per-knot patches would overwrite each other — see
  `movePatches` in useCurveInteraction for the pattern).
- **interpolate**: dropdown `const / linear / ease in / ease out /
  ease in out`. All selected share a mode → that mode; mixed → `-`.
  Selecting the mode a point already has is a **no-op** (idempotent:
  never resets dragged handles to the flat defaults).
- Mode changes go through **one handler** (`onInterpolate`): knot edits
  and point conversions combine into a single undo commit with one label,
  so mixed selections stay atomic.
- Derivation bounds-checks stale selections (a `KnotSel` can outlive its
  curve/knot across undo).
- Synthetic trim-boundary knots stay unselectable (unchanged).

## Mode-set semantics

### On knots

- **non-const mode M on knot P:** clear `P.s` *and* the previous knot's
  `s` (both adjacent segments interpolate — note this changes the previous
  knot's displayed mode from const). Handles per side: a side M requires
  **keeps its existing handle** if one exists, else gets the flat default
  `[±span/3, 0]`; a side M forbids is deleted. So ease in → ease in out
  keeps a dragged `i` and only adds the default `o`; linear deletes both.
  Sides without a segment are skipped.
- **const on knot P:** set `P.s`, delete `P.o` and the next knot's `i`
  (the step segment's dead handles — `P.i` belongs to the incoming
  segment and stays). The previous knot is untouched — if it
  interpolates, you get ramp-into-P-then-hold (AE hold-keyframe style),
  visible and editable.

### On discrete points (the conversion)

Selecting mode M ≠ const on event points runs one atomic op (one undo
entry, via `onInterpolate`):

- **Scope.** Per (file, port, address, arg): each maximal run of selected
  consecutive points, extended by one **element** on each existing side —
  the nearest same-property point *or existing-curve endpoint knot*,
  whichever is closer; never skip past a curve.
- **Absorption.** Every point covered by the new span becomes a knot at
  its exact `(t, v)` — no fitting. Selected points get M's handles;
  absorbed unselected points (in-between points and pulled boundaries)
  get no handles and no `s` — plain linear knots in one continuous curve.
  Runs whose extensions share an element merge into a single curve
  (the `[a, b, c]` example above). Same-`t` events dedup last-wins
  (knot `t` must stay strictly increasing or the player rejects the
  line); all of them are deleted.
- **Refusal.** An event that cannot be absorbed — a non-numeric arg
  differing from the group's template — would survive as a live event
  inside the span, violating the invariant. The whole op refuses with a
  message instead. No partial conversion.
- **A lone point with no neighbor element on either side** can't convert;
  the non-const options are disabled.
- **Adjacent curves join.** A boundary element that is an endpoint knot of
  an existing same-(port, address, arg) curve joins that curve: the
  converter emits the merged knot list (junction knot's `s` cleared — its
  segment toward the run interpolates), and the existing overlap carving
  (`subtractCurveOverlap`) deletes the covered original.
- **Point inside an existing curve's span** (a legacy shadowed dot):
  insert a knot at `P.t` — de Casteljau split of the segment, then M's
  handles on the new knot; delete P's event.
- **Multi-arg events.** Deleting an event removes every arg's point, so
  sibling numeric args get their own curves (one per arg, knots at the
  same times, `s` on every non-last knot: their behavior stays exactly
  discrete). The refusal rule guarantees full coverage, so every absorbed
  event is deleted — nothing is left shadowed.

### Reverse (knot → const)

Just the knot-level const op above. The curve stays one curve; no events
come back. Round-tripping a converted point leaves the data as a curve —
accepted.

## Player (vtr-player)

- `curve.rs`: `Knot.s`, parse it, step branch in `value_at`.
- Conformance (`conformance_resolver.rs` / `conformance_session.rs`):
  hold across a step span; jump exactly at the right knot's `t`; pump
  dedup doesn't spam during the hold; seek into a step span resolves the
  held value; mixed step + bezier segments in one curve; `s` parse +
  unknown-key compat.
- **Not in scope:** legacy Replace with Curve fits can still leave
  uncovered events inside a span (the editor kept them visible), where
  the pump/dedup staleness applies to bezier for ~1 tick. A resolver-side
  re-assert (clear `group_last` when a same-address event fires) is a
  possible follow-up hardening, not needed once conversion enforces the
  invariant.

## Editor internals

- `shared/curve.ts`: `evalCurve` step branch, `clipCurve` step split +
  `s` adoption (see schema section), `clampHandleTimes` ignores dead
  handles on step segments. `shared/edits.ts`: `deletePoints` strips `s`
  from a new last knot.
- New pure modules with colocated vitest:
  - `curveMode.ts` — derive a selection's mode, apply a mode to knots
    (idempotent; per-curve grouped output).
  - `curveConvert.ts` — points → knots op (runs, absorption, curve
    join/insert, refusal, multi-arg siblings). Emits the
    `(event dels, curve adds)` shape of `buildCurveReplace`, so the
    overlap carving in `replaceWithCurves` handles curve joins.
- Step segment **geometry lives in `curveGeom.ts` (`walkMerged`)**, not
  curvePaint: the same walk feeds painting, hit-testing, and
  `mergedValueAt`, so a hold draws as horizontal line + vertical jump and
  hit-tests the drawn shape (patching curvePaint alone would leave
  hit-testing on the phantom linear third).
- Handle interaction: no handle affordance for dead sides — `o` blocked
  when `knots[i].s`, `i` blocked when `knots[i-1].s` (cross-knot
  condition, `handleViews` in useCurveInteraction); `setKnotHandle`
  guards the same so a dead handle can't be written back.
- `onPointEdit`/`onInterpolate` carry an undo label (App.tsx hard-codes
  labels today).
- e2e hooks: `__curveKnots` exposes `s` **and handle presence**; header
  input/dropdown get aria-labels.
