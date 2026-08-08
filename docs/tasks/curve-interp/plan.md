# Curve point interpolation — implementation plan

Spec: `spec.md`. Five commits, in this order (1–2 land the semantics
before any UI writes `s`).

## 1. shared math — step segments

`feat(editor): step segments in shared curve math`

- `shared/types.ts`: `CurveKnot.s?: true` with the doc comment (segment
  leaving this knot holds `v`; dead handles; meaningless on the last
  knot).
- `shared/curve.ts`:
  - `evalCurve`: if the segment's left knot has `s`, return its `v`
    (skip bezier entirely).
  - `clipCurve`: splitting inside a step segment inserts the boundary
    knot `{t, v: left.v, s: true}` instead of de Casteljau; interior
    copies keep `s`.
  - `clampHandleTimes`: skip handles on step segments (they're dead;
    don't resurrect or scale them).
- `curve.test.ts`: step eval (hold, jump at right knot `t`), clip split
  inside/around a step segment, mixed step + bezier curve, flat-extension
  edges unchanged.
- `merge.test.ts`: a trimmed clip exports a step curve with `s` intact.
- README: `s` row in the knot schema table + old-player degrade note.

## 2. player — step evaluation

`feat(player): step segment evaluation`

- `curve.rs`: `Knot.s: bool`, parse `"s"` (absent → false), step branch
  in `value_at` (left knot of the segment has `s` → left `v`).
- `conformance_session.rs`: `s` parses; unknown keys elsewhere still
  skip gracefully.
- `conformance_resolver.rs`: hold across the span during pump (dedup — no
  duplicate emissions); value jumps exactly at the right knot's `t`; seek
  into a step span resolves the held value; mixed segments.
- `cargo test` both crates; rebuild release binaries (stale-binary
  gotcha).

## 3. editor — header value + interpolation on knots

`feat(editor): curve header value and interpolation editor`

- `curveMode.ts` (+ test): 
  - `deriveMode(sel el) → 'const' | 'linear' | 'ease-in' | 'ease-out' |
    'ease-in-out'` per spec (event point → const; knot → `s` / handle
    presence; dead sides don't count);
  - `applyModeToKnots(knots, index, mode) → CurveKnot[]`: const sets `s`
    + drops own handles + next's `i`; non-const clears own and previous
    `s`, sets flat `±span/3` handles per mode.
- `CurvePanel.tsx` header: value input + dropdown between the tool
  buttons and zoom controls. Common-value/mode display, `-` placeholder
  when mixed, Enter/blur commit, Esc revert. Value commits through
  `onPointEdit` (EventPatch value / CurvePatch with knot `v` replaced,
  handles kept), one commit for the whole selection.
- Mode changes on knot selections go through `onPointEdit` CurvePatch
  (whole-knot-array replacement, existing machinery). Undo labels:
  `"value edit"`, `"interpolation: <mode>"`.
- `curvePaint.ts`: step segment = horizontal line + vertical jump; skip
  handle rendering on step segments.
- e2e: select knots → dropdown const → `__curveKnots` shows `s` and no
  handles; back to ease in out → handles return; value input edits all
  selected.

## 4. editor — discrete point conversion

`feat(editor): convert discrete points to curve knots`

- `curveConvert.ts` (+ test), pure, clip-local like `curveReplace.ts`:
  input = selected event points + the property's full point/curve context;
  output = `{ dels, adds }` (the `onCurveReplace` shape — overlap carving
  in `replaceWithCurves` already turns "append merged knots" into curve
  merge/replace).
  - runs per (file, property) + one-neighbor extension each side;
  - exact `(t, v)` knots, M handles on selected, bare boundary knots;
  - neighbor = endpoint knot of an existing curve → merged knot list;
    both sides → single merged curve;
  - point inside a curve span → de Casteljau insert + M handles;
  - sibling numeric args → all-step curves at the same times; event
    deleted only when fully covered (reuse `buildCurveReplace`'s
    coverage rule);
  - lone isolated point → null (dropdown options disabled).
- `CurvePanel.tsx`: dropdown on event-point selections calls the
  converter through the existing `onCurveReplace` handler; undo label
  `"N points → curve"`. Disable non-const options when conversion is
  impossible.
- Unit tests: run extension, curve merge both sides, span insert,
  multi-arg siblings stay discrete, isolated point null, undo round-trip
  (dels + adds symmetric).
- e2e: discrete fixture → select one point → `ease in out` →
  `__curveProps` gains a curve, `__curveKnots` has 3 knots with handles
  on the middle; undo restores the points.

## 5. docs

`docs: curve interpolation modes`

- README: `/vtr` untouched; JSONL schema knot table already updated in 1 —
  add the header UI to the editor feature list.
- `docs/ARCHITECTURE.md`: only if the curve overlay description mentions
  knot fields.
- Close the loop on `docs/tasks/curve-interp/` (link from TODO if
  tracked).

## Risks / watch items

- **Handle-drag interaction on step knots**: `useCurveInteraction` may
  offer handle drags for knots whose handles are dead — audit in 3 and
  suppress (no handle hit targets on step segments).
- **`subtractCurveOverlap` merge path**: relies on the merged span
  covering the originals exactly (ends inclusive) so remainders vanish;
  pin with a unit test in 4 rather than assuming.
- **Prev-knot `s` clearing** (non-const rule) crosses knot boundaries in
  one CurvePatch — fine (whole-array replacement), but the derive/display
  must re-run from the patched doc so the header updates live.
