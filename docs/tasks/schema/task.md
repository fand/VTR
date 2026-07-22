# Clip JSONL drops OSC type tags

Status: done (2026-07-17). Fixed on `feat/schema-types`: vtr-tap records a
`types` tag string per event, the editor carries it through merge/export and
encodes preview OSC by it. See [plan.md](plan.md); schema documented in the
README.

## Problem

vtr-tap parses each OSC packet and writes its args as plain JSON
(`vtr-tap/src/tap.rs` `arg_to_json`). OSC args are typed (`i` int32, `f`
float32, `d` float64, `h` int64, `s` string, `I` impulse, `r` color, …) but
the JSONL line keeps only JSON numbers/strings. The mapping is not injective,
so the original tags cannot be recovered:

- `Float(0.5)` and `Double(0.5)` → `0.5`
- `Int(3)`, `Long(3)`, and `Float(3.0)` → `3`
- `Color` → `"#rrggbbaa"`, `Impulse` → `"<impulse>"` — indistinguishable from
  real strings with those values

The loss happens **at record time**. Everything downstream inherits it.

## Symptoms

### 1. Preview replay guesses types (`vtr-editor/src/main/osc.ts`)

`encodeOscMessage` re-encodes JSON args to OSC:

| JSON value          | guess    | wrong when                                        |
| ------------------- | -------- | ------------------------------------------------- |
| integer within ±2³¹ | `i`      | source was `f`/`d` with an integral value (`2.0`) |
| other number        | `f` f32  | source was `d` (precision) or `h` > 2³¹ (value)   |
| `"<impulse>"`       | `I`      | source was a genuine string                       |
| `"#rrggbbaa"`       | `r`      | source was a genuine string                       |

Two failure classes: precision loss (`d`/`h` → f32) and type confusion
(string → impulse/color, float → int).

### 2. Exported session.jsonl passes the loss on

Export copies the recorded JSON unchanged — no *additional* loss, but the
type information is already gone. session.jsonl is meant to be replayed by a
TouchDesigner-side script; that script must guess exactly like `osc.ts` does,
with no guarantee its guesses match ours. The original TODO's "affects
preview only" was wrong: every consumer of the JSONL is affected.

## Why it matters / why it waited

Typical TD traffic is floats in 0..1, which survive the f32 round trip; real
`"<impulse>"` strings are unlikely. The most probable real-world bite is
float-with-integral-value → int (a receiver expecting `f` gets `i`). Low
frequency, but silent and unfixable after the fact — recordings made today
stay ambiguous forever.

## Fix direction

Record the type tag string per event in vtr-tap's JSONL, e.g.:

```json
{"t":0.5,"port":10000,"a":"/fader","types":"ff","args":[0.42,2.0]}
```

- `vtr-tap` (`arg_to_json` call site): emit the rosc tag per arg alongside the
  JSON value. Skipped args (blob) must skip their tag too, so `types` and
  `args` stay aligned.
- `vtr-editor/src/main/osc.ts`: use `types` when present; keep the current
  guessing as fallback for old clips (back-compat — `types` is an additive
  field, old readers ignore it).
- Events added in the curve editor have no recorded tags; they stay on the
  guess path (their args are editor-made floats, so `f` is correct anyway).
- Document the field so TD-side replay scripts can use it.

## Touch points

- `vtr-tap/src/tap.rs` — `arg_to_json` / packet write loop, plus its tests
- `vtr-editor/src/main/osc.ts` — `encodeOscMessage`
- `vtr-editor/src/main/clips.ts` — clip reader (carry `types` through)
- `vtr-editor/src/shared/types.ts` — `OscEvent` (optional `types?: string`)
- `vtr-editor/src/main/merge.ts` / `session.ts` — keep `types` on merged
  events so export carries it
- README / export docs — describe the schema field

## Open questions

- Tag charset: rosc supports arrays (`[`/`]`) and midi/time tags we currently
  stringify; decide whether `types` covers only the args we serialize.
- Should preview *warn* when it falls back to guessing (old clip)? Probably
  not — silent fallback matches current behavior.
