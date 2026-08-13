# Curve point interpolation — implementation plan

Spec: `spec.md` (post-review revision: span-invariant + absorption).
Five commits, **one PR**, in this order (1–2 land the semantics before
any UI writes `s`). The task docs (`docs/tasks/curve-interp/`,
`docs/tasks/track-priority/`) go in the same branch as a docs commit.
Track priority is implemented after this task ships.

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
    copies keep `s`; **a split inside a bezier segment whose right knot
    has `s` keeps that `s`** — both in the `ctrlToKnots` rebuild and in
    the interior-knot adoption pass (which today copies only `o`).
  - `clampHandleTimes`: skip handles on step segments (they're dead;
    don't resurrect or scale them).
- `shared/edits.ts`: `deletePoints` strips `s` from the new last knot
  (today it strips only boundary handles).
- `curve.test.ts`: step eval (hold, jump at right knot `t`), clip split
  inside a step segment, **clip split in the bezier segment before a step
  knot (the `s`-adoption case)**, mixed step + bezier curve,
  flat-extension edges unchanged.
- `merge.test.ts`: a trimmed clip exports a step curve with `s` intact —
  including a trim boundary inside the segment *before* a step knot.
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
  - `deriveMode(el) → 'const' | 'linear' | 'ease-in' | 'ease-out' |
    'ease-in-out'` per spec (event point → const; knot → `s` / handle
    presence; dead sides don't count; bounds-checks stale `KnotSel`);
  - mode application returns **one new knot array per curve** (indices
    applied together — per-knot CurvePatches would overwrite each other):
    const sets `s` + drops `o` and next's `i` (keeps own `i`); non-const
    clears own and previous `s`; per side, a required handle is **kept if
    present** else defaulted to flat `±span/3`, a forbidden one deleted
    (idempotent by construction — dragged handles survive same-mode and
    mode-widening changes).
- `CurvePanel.tsx` header: value input + dropdown between the tool
  buttons and zoom controls. Common-value/mode display, `-` placeholder
  when mixed, Enter/blur commit, Esc revert. Value commits through
  `onPointEdit`, chained per curve (EventPatch value / one CurvePatch per
  curve with knot `v` replaced, handles kept).
- New `onInterpolate` handler in App.tsx: applies knot mode changes (this
  commit) and later point conversions (commit 4) in **one undo commit**
  with its own label (`"interpolation: <mode>"`); `onPointEdit` gains a
  label parameter for `"value edit"` (labels are hard-coded in App.tsx
  today).
- `curveGeom.ts` (`walkMerged`): step segment emits horizontal line +
  vertical jump — painting, hit-testing, and `mergedValueAt` all follow
  from the one walk. No curvePaint-only patch.
- Handle suppression: `handleViews` (useCurveInteraction) skips `o` when
  `knots[i].s` and `i` when `knots[i-1].s`; `setKnotHandle` guards the
  same.
- e2e: select knots → dropdown const → `__curveKnots` shows `s` and no
  handles; back to ease in out → handles return; re-selecting the current
  mode leaves dragged handles alone; value input edits all selected
  (multiple knots of one curve included).

## 4. editor — discrete point conversion

`feat(editor): convert discrete points to curve knots`

- `curveConvert.ts` (+ test), pure, clip-local like `curveReplace.ts`:
  input = selected event points + the property's full point *and curve*
  context; output = `{ dels, adds }` (the `onCurveReplace` shape —
  overlap carving in `replaceWithCurves` turns "append merged knots" into
  join/replace) **or a refusal** (`null` + reason) when the span
  invariant can't hold.
  - runs per (file, port, address, arg); boundary element = nearest
    point *or curve endpoint knot*, never skipping past a curve;
  - absorption: every covered point becomes a knot — selected get M
    handles, others plain linear; runs sharing a boundary element merge
    into one curve (`[a, b, c]` with a+c selected → one 5-knot curve);
  - same-`t` events dedup last-wins, all deleted (strict monotonicity —
    the player rejects equal-`t` knots);
  - boundary element = existing curve endpoint → merged knot list,
    junction `s` cleared;
  - point inside a curve span → de Casteljau insert + M handles;
  - sibling numeric args → all-step curves at the same times; refusal
    when a non-numeric arg differs from the group template (no leftover
    events inside any new span — the invariant);
  - lone isolated point → non-const options disabled.
- `CurvePanel.tsx` / App.tsx: dropdown on event-point selections routes
  through `onInterpolate` (one commit, label `"N points → curve"`; a
  mixed knots+points selection commits once). Refusal surfaces as a
  toast/status message, not a silent no-op.
- Unit tests: run extension, in-between absorption (a+c selected), curve
  join both sides, span-equal join (existing curve fully covered →
  deleted with no remainders — pin the `subtractCurveOverlap`
  assumption), span insert, multi-arg siblings stay discrete, dup-`t`
  dedup, refusal on template mismatch, isolated point null, undo
  round-trip (dels + adds symmetric).
- e2e: discrete fixture → select one point → `ease in out` →
  `__curveProps` gains a curve, `__curveKnots` has 3 knots with handles
  on the middle; undo restores the points; select two points around a
  third → one curve with 5 knots.

## 5. docs

`docs: curve interpolation modes`

- README: JSONL schema knot table already updated in 1 — add the header
  UI to the editor feature list.
- `docs/ARCHITECTURE.md`: only if the curve overlay description mentions
  knot fields.
- Close the loop on `docs/tasks/curve-interp/` (link from TODO if
  tracked).

## Follow-ups (out of scope)

- **Track priority — lower track wins** (`docs/tasks/track-priority/`):
  merge-time masking so an overdubbed take beats an upper track's curve;
  also gives the curve editor its missing "which overlapping curve
  plays" visual.
- **Legacy Replace with Curve leftovers**: fitted spans can still contain
  uncovered events (visible, shadowed on seek, stale-for-one-tick during
  pump on bezier). Options: adopt the same absorb-or-refuse invariant
  there, and/or resolver hardening (clear `group_last` when a
  same-address event fires mid-span). Decide separately.

## Risks / watch items

- **`subtractCurveOverlap` join path**: relies on the merged span
  covering the original exactly (ends inclusive) so remainders vanish —
  pinned by a unit test in 4, not assumed.
- **Refusal UX**: the dropdown looks actionable but can refuse; the
  message must say *why* (which event, which arg). Check it reads well
  with multi-clip selections.
- **Prev-knot `s` clearing** (non-const rule) crosses knot boundaries in
  one per-curve patch — the header's derive/display must re-run from the
  patched doc so the label updates live.
