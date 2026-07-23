# Replace with Curve (issue #19)

Add a **Replace with Curve** button to the curve editor header. Clicking it
fits the closest (piecewise cubic) bezier curve to the targeted points and
replaces those points with a smooth, simplified resampling of the fitted
curve — one undo entry, fully non-destructive (edit overlay only).

Issue: <https://github.com/fand/VTR/issues/19>

## Motivation

Recorded OSC automation (faders, XY pads) is dense and noisy: hundreds of
points for one gesture. That makes hand-editing in the curve panel painful.
Fitting a bezier and replacing the raw points yields a smooth curve with far
fewer points that is easy to reshape with the existing drag / transform-box
tools.

## Scope decision: events stay the data model

The session format, player resolver, and TD component only know discrete OSC
events (step-after semantics, `vtr-player/tests/conformance_*.rs`). This
feature does **not** introduce a bezier primitive anywhere in the data model.
The fitted curve exists only transiently inside the button handler; its
output is ordinary events written through the existing `ClipEdits` overlay
(`del` the originals, `add` the resampled points). Player, export, tap, and
conformance tests are untouched.

A persistent bezier segment type (player-side interpolation, schema v3,
conformance additions) is explicitly **out of scope** — tracked separately if
ever needed.

## UX

- **Placement**: the curve panel header, next to Snap / Transform Box /
  Pencil (the issue says "timeline header", but the operation acts on curve
  points, whose selection and tooling all live in the curve panel header —
  same reasoning as Fit Zoom, #22). Icon: lucide `Spline`, tooltip
  "Replace with Curve", `aria-label="replace with curve"`.
- **Target resolution** (mirrors Fit Zoom's precedence):
  1. If ≥ 3 selected points share a (property, clip) group → those groups.
  2. Else, if a property is selected (thick curve) → all its points, grouped
     per clip.
  3. Else the button is disabled.
  Hidden and dimmed properties are excluded, as everywhere else.
- **Result**: replaced points disappear, the new sampled points appear and
  become the point selection (matching pencil-stroke behavior). Undo label:
  `"N points replaced with curve"`.

## Fitting algorithm

Schneider's least-squares piecewise cubic bezier fit (Graphics Gems, "An
Algorithm for Automatically Fitting Digitized Curves"):

1. Chord-length parameterize the input points.
2. Least-squares fit one cubic with end tangents from the data.
3. Newton–Raphson reparameterization (a few iterations).
4. If max error > tolerance, split at the worst point and recurse.

Fitting runs in normalized space — `t` divided by the group's time span, `v`
by the property's `max - min` — so the tolerance is scale-independent.
Constant `FIT_ERROR = 0.01` (1 % of range) to start; a user-facing tolerance
control is future work.

### Resampling

The fitted segments are sampled back into events **uniformly in time at
`RESAMPLE_HZ = 60`**, always including each segment's endpoints, so playback
(step-after at event times) stays visually smooth while typical 120 Hz+
recordings still shrink substantially. Guards:

- Output count is capped at the input count (never densify).
- Sample times are forced strictly increasing (a least-squares cubic can
  locally overshoot in x); non-monotone samples are dropped.
- First/last input times are preserved exactly so the curve's span and its
  joins to untouched neighbors don't drift.

## Data flow / wiring

New pure module `vtr-editor/src/renderer/src/components/curveFit.ts` with a
colocated `curveFit.test.ts` (no DOM, same pattern as `curveGeom.ts`):

```ts
interface Pt { t: number; v: number }
interface Cubic { p0: XY; p1: XY; p2: XY; p3: XY }
fitCurve(points: Pt[], maxError: number): Cubic[]
resampleCurve(segments: Cubic[], hz: number, maxPoints: number): Pt[]
```

`CurvePanel` gains one prop and one header button:

```ts
/** Replaces points atomically: one undo entry for the delete + the adds. */
onPointsReplace: (dels: PointSel[], adds: PointAdd[]) => void
```

The click handler groups eligible points by `(property.key, clip.id)`, fits
and resamples each group, and builds:

- `dels`: the original points' `PointSel`s (event-level `del` in the overlay).
- `adds`: new events built like the pencil's `makeAdd` — nearest original
  event as the template (port, address, other args), `t` written clip-local
  and clamped to the clip span, `eventIndex` continuing past
  `events.length + add count` per file (append-only key space).

`App.tsx` gains `onPointsReplace`, a single `commit()` that applies both the
`del` map and the `add` pushes, then selects the new points — undo/redo and
autosave come free from the existing doc/patch machinery.

### Multi-arg events

Deleting an event removes *all* of its args' points, not just the fitted
property's. So each added sample also rewrites the event's **other** numeric
args with their own step-after value at the sample time (`valueAt`), i.e.
sibling properties are resampled onto the new time grid rather than lost.
This is documented in the module and covered by a unit test.

## Edge cases

- Group with < 3 points: skipped; button disabled when no group qualifies.
- Collinear / constant input: fit degenerates to one segment; resampling cap
  still applies.
- Snap toggle does **not** apply to generated samples (they come from the
  fit, not the pointer).
- Multi-clip properties: fitted independently per clip; no events are
  created outside their source clip's span.
- Missing/unloaded clips: groups whose events aren't in `eventsCache` are
  skipped (same guard as `makeAdd`).

## Tests

Unit (`curveFit.test.ts`):
- Points sampled from a known cubic are recovered within tolerance by a
  single segment.
- A noisy ramp fits within tolerance; output is monotone in `t`.
- A V-shape splits into ≥ 2 segments.
- `resampleCurve` honors `hz`, the `maxPoints` cap, and endpoint inclusion.

Unit (App/`CurvePanel` level, colocated): replace handler produces correct
`del` keys, add `eventIndex` continuation, clip-local clamped `t`, and
sibling-arg resampling.

E2E (`e2e/curve.spec.ts` or a new `curve-fit.spec.ts`): load a dense fixture
clip, select a property, click the button, assert via `__curvePoints` that
the count dropped and endpoints kept their values; undo restores the
original count.

## Implementation order

1. `curveFit.ts` + unit tests (pure math, no UI).
2. `App.tsx` `onPointsReplace` + `CurvePanel` button + group/build logic.
3. E2E spec + fixture.
4. Manual pass via `./run` with a real recording.

Commits follow `feat(editor): …` / `test(editor): …`.
