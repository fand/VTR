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
  Writers avoid it; readers ignore it.
- `fitCurve` never emits `s`.
- `clipCurve` splitting inside a step segment inserts the boundary knot
  with the left knot's `v` and `s` — no de Casteljau needed. Trim/export
  (`merge.ts`) then carries steps for free.
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
  Esc reverts. Not clamped by the limit toggle.
- **interpolate**: dropdown `const / linear / ease in / ease out /
  ease in out`. All selected share a mode → that mode; mixed → `-`.
- Synthetic trim-boundary knots stay unselectable (unchanged).

## Mode-set semantics

### On knots

- **non-const mode M on knot P:** clear `P.s` *and* the previous knot's
  `s` (both adjacent segments interpolate — note this changes the previous
  knot's displayed mode from const). Set handles per M: an ease side gets
  a flat handle `[±span/3, 0]`, linear deletes both. Sides without a
  segment are skipped.
- **const on knot P:** set `P.s`, delete both of P's handles and the next
  knot's `i` (dead on a step segment). The previous knot is untouched — if
  it interpolates, you get ramp-into-P-then-hold (AE hold-keyframe style),
  visible and editable.

### On discrete points (the conversion)

Selecting mode M ≠ const on event points runs one atomic op (one undo
entry):

- **Scope.** Per (file, property): each maximal run of selected
  consecutive points, extended by one neighbor point on each existing
  side. Selected points become knots with M's handles; pulled-in
  neighbors become boundary knots with no handles and no `s` (their
  segment toward the run now interpolates — that is the point of the
  rule). Knots take the exact `(t, v)` of their points — no fitting
  (unlike Replace with Curve).
- **A lone point with no neighbor on either side** can't convert; the
  non-const options are disabled.
- **Adjacent curves merge.** A neighbor that is an endpoint knot of an
  existing same-property curve joins that curve instead of starting a new
  one (both sides curves → one merged curve). Implementation rides on the
  existing overlap carving: append the merged knot list and
  `subtractCurveOverlap` deletes the covered originals.
- **Point inside an existing curve's span** (shadowed dot): insert a knot
  at `P.t` — de Casteljau split of the segment, then M's handles on the
  new knot; delete P's event.
- **Multi-arg events.** Deleting an event removes every arg's point, and
  the new span shadows the address anyway — so sibling numeric args get
  their own curves (one per arg, knots at the same times, `s` on every
  non-last knot: behavior stays exactly discrete). An event is deleted
  only when every numeric arg is carried and non-numeric args match the
  template (`buildCurveReplace`'s rule); leftovers stay visible but
  shadowed — same precedent as Replace with Curve.

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

## Editor internals

- `shared/curve.ts`: `evalCurve` step branch, `clipCurve` step split,
  `clampHandleTimes` ignores dead handles on step segments.
- New pure modules with colocated vitest:
  - `curveMode.ts` — derive a selection's mode, apply a mode to knots.
  - `curveConvert.ts` — points → knots op (runs, neighbor pull-in, curve
    merge/insert, multi-arg siblings). Emits the same (event dels, curve
    adds) shape as `buildCurveReplace`, so `onCurveReplace` wiring is
    reused.
- `curvePaint.ts`: a step segment draws as a horizontal line to the next
  knot's `t` plus the vertical jump; no handles drawn on step segments.
- e2e hooks: `__curveKnots` exposes `s`; header input/dropdown get
  aria-labels.
