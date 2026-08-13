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

Windows are inclusive at both ends (an upper event exactly on a boundary
drops), and everything else sits one ±1e-6 step off them — one step of the
export grid (round6), so rounding can't collapse a margin onto its
boundary. The resolver shadows a point at a span *end* forever, so live
curve pieces must stay clear of the lower track's boundary events.

- **Entering a mask** (upper curve carved at 2): the carved left piece
  ends at `2 - 1e-6` and its end value holds — the take's address plays
  its held old value until the take's first event (plain OSC hold;
  nothing synthesized).
- **Leaving a mask** (at 4): the upper track resumes *with its current
  value*:
  - a carved curve resumes exactly (the right piece starts at `4 + 1e-6`;
    its first knot is the de Casteljau split value, and its def time
    tracks pos, so it outranks the take's stale events from the boundary
    on);
  - masked discrete data synthesizes its latest definition as one event
    at `4 + 1e-6` — otherwise the old track would stay silent until its
    next real event, unlike the curve case (punch-out resumes the old
    material, DAW-style). `+1e-6` also puts it after the take's own
    boundary event, so the fresh value wins the tie.
  - **resume value** = the track's own resolved value at the mask end:
    its events *and* its curves' end values (a fully swallowed curve
    resumes at its last value), by the resolver's last-def-wins rule.
    The winning event's `args` are the template; each curve that outranks
    it splices its value in at its own arg index.
  - **no resume** when a live carved piece of the same key already covers
    that time (it resumes by itself, and an event inside a span never
    plays), when the time lands inside the next mask window for that key
    (a sub-grid gap between two windows), or when no clip window of the
    upper track contains the mask end (punch-out past the clip's end
    resumes nothing).

## Stacking

Masks apply bottom-up: each track masks every track above it. Three
tracks → track 3 masks 1 and 2, track 2 masks 1. Clips on one track
never mask each other (same-track behavior unchanged), so a resume can
hold a value defined in an earlier clip on the same track.

## Implementation

- New pure module (shared, vitest): from the project's tracks, compute
  per-(port, address) mask intervals per track index; apply to a track's
  data = drop events inside the intervals + carve curves with `clipCurve`
  + synthesize the resume events.
- `merge.ts` applies it when flattening (export and preview both go
  through merge, so replay and preview agree for free).
- **UI shares the masking**: `buildProperties` (curveModel) applies the
  same module so the curve editor draws masked regions as reality —
  masked curve stretches dim and dashed, masked dots dim, both excluded
  from the merged path like shadowed points today. Knots keep full alpha:
  they are the edit affordance, not played material. Masked elements stay
  **selectable and editable** (like shadowed dots): they don't play, but
  edits apply and moving clips brings them back. This also fixes the standing gap that
  overlapping curves give no visual hint of which one plays.
- Tests (`merge.test.ts` + module tests): the [0,10]/[2,4] example;
  boundary hold-in and resume (curve and discrete uppers); per-address
  scope (unrelated address passes through); port separation; muted clip
  doesn't mask; three-track stacking; trim/offset interaction.

## Compatibility

- Editor-only change; exported sessions are ordinary events + curves.
- Existing projects with overlapping tracks re-export differently
  (that's the point). Release note; no migration.
