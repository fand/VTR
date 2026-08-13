# Track priority — the lower track wins

At any time, for a given (port, address), the **lowest track** carrying
that address wins. Everything above it is masked for that window.

Motivation: overdub. A new take lands as a new bottom track
(`maybeImportClip` pushes, App.tsx), so "lower wins" = "newest take
wins". Today a bezier curve outranks recorded events inside its span
forever (the pinned def-time rule), so recording over a curve produces a
take that never plays — the natural expectation is the opposite.

Example: track 1 has a bezier curve [0, 10], track 2 a recorded take
[2, 4] on the same address → 0–2 plays the curve, 2–4 the take, 4–10 the
curve again.

## Decisions

- **Applies to everything**, not just curves: upper-track discrete events
  inside a mask window are dropped too. One rule explains the whole
  timeline; the old interleaved last-def-wins between overlapping
  discrete takes changes behavior (accepted).
- **Mask key is (port, address).** Port = tap listen port = input route;
  two controllers on two ports collide on address strings (TouchOSC
  defaults are generic). Every existing grouping (resolver addr table,
  `subtractCurveOverlap`, `buildCurveReplace`) already keys on (port, a).
- **Mask extent is the clip's full trimmed window**, per (port, address)
  the clip actually carries (≥ 1 event or a curve for that key inside the
  trim). A take owns its window for the addresses it touched; addresses
  it never sent pass through from above.
- **Track order is semantic.** Reordering tracks changes what plays —
  priority is an arrangement tool. Document in README.
- **Muted clips don't mask.**
- **Resolver untouched.** Priority is resolved structurally at merge
  time; session.jsonl schema, player, and conformance stay as they are.
  Same philosophy as curve-interp's span invariant: the editor emits
  data with no dead regions, the resolver stays dumb.

## Semantics at mask boundaries

- **Entering a mask** (upper curve carved at 2): the carved left piece's
  end value holds — the take's address plays its held old value until the
  take's first event (plain OSC hold; nothing synthesized).
- **Leaving a mask** (at 4): the upper track resumes *with its current
  value*:
  - a carved curve resumes exactly (the right piece's first knot is the
    de Casteljau split value; its def time tracks pos, so it outranks the
    take's stale events from the boundary on);
  - masked discrete data synthesizes its latest masked definition as one
    event at the mask end — otherwise the old track would stay silent
    until its next real event, unlike the curve case (punch-out resumes
    the old material, DAW-style).

## Stacking

Masks apply bottom-up: each track masks every track above it. Three
tracks → track 3 masks 1 and 2, track 2 masks 1. Clips on one track
never mask each other (same-track behavior unchanged).

## Implementation

- New pure module (shared, vitest): from the project's tracks, compute
  per-(port, address) mask intervals per track index; apply to a track's
  data = drop events inside the intervals + carve curves with `clipCurve`
  + synthesize the resume events.
- `merge.ts` applies it when flattening (export and preview both go
  through merge, so replay and preview agree for free).
- **UI shares the masking**: `buildProperties` (curveModel) applies the
  same module so the curve editor draws masked regions as reality —
  masked curve pieces and points dimmed/dashed, excluded from the merged
  path like shadowed points today. Masked elements stay **selectable and
  editable** (like shadowed dots): they don't play, but edits apply and
  moving clips brings them back. This also fixes the standing gap that
  overlapping curves give no visual hint of which one plays.
- Tests (`merge.test.ts` + module tests): the [0,10]/[2,4] example;
  boundary hold-in and resume (curve and discrete uppers); per-address
  scope (unrelated address passes through); port separation; muted clip
  doesn't mask; three-track stacking; trim/offset interaction.

## Compatibility

- Editor-only change; exported sessions are ordinary events + curves.
- Existing projects with overlapping tracks re-export differently
  (that's the point). Release note; no migration.
