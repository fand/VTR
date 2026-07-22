# Plan: record OSC type tags in clip JSONL (`types` field)

Status: done. Task: [task.md](task.md).

## Decision

Add a per-event `types` field: one string, one tag char per `args` element,
matching the OSC type tag string (minus the leading `,`):

```json
{"t":0.5,"port":10000,"a":"/fader","types":"ff","args":[0.42,2.0]}
```

- Additive field. Old clips lack it → readers keep the current guess path.
- `types[n]` describes `args[n]`. Skipped args (blob) skip their tag too.
- `types` covers only what we serialize: the fallback debug-stringify branch
  tags `s` (it IS a string in the JSON). No `[`/`]` array tags.
- int64 (`h`) with |value| > 2^53: write the arg as a decimal **string** so
  JS `JSON.parse` can't round it. The `h` tag tells readers to parse it back.

## Steps

### 1. vtr-tap: emit tags (`vtr-tap/src/tap.rs`)

- Change `arg_to_json` → `arg_to_json_tagged(&OscType) -> Option<(char, Value)>`:
  - `Float`→`f`, `Double`→`d`, `Int`→`i`, `Long`→`h`, `String`→`s`,
    `Color`→`r`, `Inf`→`I`, `Nil`→`N`, `Bool(true)`→`T`, `Bool(false)`→`F`.
  - `Long` with |v| > 2^53 → `Value::String(v.to_string())`.
  - `Blob` → `None` (drops value AND tag, alignment holds).
  - fallback stringify branch → `s`.
- Packet write loop (~line 386): collect `(String, Vec<Value>)`, insert
  `"types"` next to `"args"`.
- Tests (`mod tests`): tag/arg alignment with a blob in the middle; `T`/`F`
  by value; big `h` as string; each tag char.

### 2. Editor types (`vtr-editor/src/shared/types.ts`)

- `OscEvent`: add `types?: string`.

### 3. Clip reader (`vtr-editor/src/main/clips.ts`)

- Lines are cast to `OscEvent`, so `types` flows through as-is. Add a test:
  one line with `types`, one without.

### 4. Merge (`vtr-editor/src/main/merge.ts`)

- The event copy (~line 34) rebuilds objects; add `types: e.types`
  (`JSON.stringify` drops `undefined`, so old clips stay clean).
- Curve-editor-added events (`edits.add`) have no `types` → guess path.
  Their args are editor-made floats, so the `f` guess is right.

### 5. Export (`vtr-editor/src/main/session.ts`)

- Line 28 rebuilds the JSON line; include `types: e.types`.

### 6. Encoder (`vtr-editor/src/main/osc.ts` + `preview.ts`)

- `encodeOscMessage(addr, args, types?)`:
  - No `types`, or `types.length !== args.length` → current guessing,
    unchanged.
  - Else encode per tag: `i` int32, `f` f32, `d` `writeDoubleBE`,
    `h` `writeBigInt64BE` (accept string or number), `s` string,
    `r` color, `T`/`F`/`I`/`N` no payload.
  - Value/tag mismatch policy (curve edits can change a value under a tag):
    - `i`/`h` with non-integer value → round. An edited int curve stays int.
    - `r` with a non-`#rrggbbaa` string, or non-number under `i/f/d/h` →
      fall back to guessing for that arg only.
- `preview.ts` line 72: pass `e.types`.
- Tests: byte-exact round trip for `d` precision and `h` > 2^31; genuine
  `"<impulse>"` string with tag `s` stays a string; mismatch fallbacks.

### 7. Docs

- README export section: document `types`, the tag charset, and the
  string-encoded big `h` rule (TD replay scripts need both).
- `task.md`: status → done, link commits.

## Verification

- `cargo test` in `vtr-tap`; `npm test` in `vtr-editor`.
- End-to-end: script sends args of each type → record → check JSONL tags →
  preview replay → capture with a dump tool → tags match the original send.
- Back-compat: load a pre-change clip; preview and export behave as today.

## Resolved open questions (from task.md)

- Tag charset: only serialized args; fallback branch tags `s`; no array tags.
- No warning on guess fallback for old clips (matches current behavior).
- Big int64: string-encoded at record time, `h` tag drives re-parse.
