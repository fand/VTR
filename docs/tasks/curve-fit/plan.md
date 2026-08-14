# Curve fit rewrite — extrema segmentation + step detection

Rework `fitCurve` (`vtr-editor/src/shared/curve.ts`) so fitted curves use
far fewer knots, and the knots land where an editor wants them: at peaks
and valleys. Today the Schneider fit splits at the max-error point, so
knots land at meaningless spots and dense recordings produce many of them.

New pipeline: **run split (step detection) → extrema split → per-segment
Schneider fit**. Reuse `generateBezier`, `fitCubicRec`, and
`clampHandleTimes` as they are.

## 1. `shared/curve.ts` — `fitCurve(points, maxError, frame = 1/60)`

Processing order:

1. **Same-t dedup** (unchanged, last-wins) + normalize (t by time span,
   v by value range).
2. **Run split = step detection**: cut where the gap between adjacent
   samples exceeds `frame` (raw seconds, default 1/60). No events means
   the value held, so bridging the gap with a bezier would invent motion.
   - At a run boundary, the left run's last knot gets `s: true`
     (hold, then jump).
   - A one-sample run (an isolated tap) becomes a single step knot.
3. **Extrema split** (inside a run, with hysteresis): walk the samples
   tracking the running max/min; when the value retreats from it by more
   than δ (normalized v), commit an extremum knot there and flip
   direction.
   - δ = `maxError`. Wiggles under the tolerance get absorbed by the fit
     anyway, so there is no separate threshold to tune.
4. **Per-segment fit**: fit each monotone segment with the existing
   `fitCubicRec`.
   - Interior extremum boundaries get horizontal tangents (±x unit
     vectors): the peak value is preserved exactly and its handles get
     dv = 0.
   - Run endpoints keep data-derived tangents, as today.
   - The error-driven recursive split stays: whether a long segment
     splits further is decided by the error, not by length. A monotone
     segment with an S-shaped speed profile misses tolerance and splits
     on its own.
5. Assemble knots → `clampHandleTimes` → strip the outer handles of the
   first/last knot (unchanged).

## 2. `curveReplace.ts`

- `FIT_ERROR`: 0.01 → **0.1**. With extrema pinned exactly, the
  in-segment tolerance can be loose; this is the main knot reducer.
  To be tuned later.

## 3. Tests — `shared/curve.test.ts`

Existing-test trap: `sampleRamp(20–81)` samples [0,1] coarsely, so gaps
exceed 1/60 and everything would turn into steps. Tests not about steps
raise the sample density to ≥120 Hz (or pass `frame: Infinity`).

New tests:

- Gap > 1 frame → step knot (hold → jump).
- A train of isolated events → all steps.
- A peak value survives exactly as an extremum knot with horizontal
  handles.
- Jitter below the threshold raises no extremum knot.
- A monotone but S-speed segment still splits (error-driven).
- Corner test (`|t - 0.5|`): the corner is an extremum, so a knot now
  lands exactly at t = 0.5 — tighten the expect.

## Design calls

- `frame` is a parameter, default 1/60. Variable TD fps comes later.
- `buildPointConversion` (selected points → curve) is out of scope; only
  the `buildCurveReplace` fit path changes.
- No player change: the knot format is unchanged, `s` keeps its existing
  semantics.
