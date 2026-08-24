# Curve editor: add new property from the property list

## Context

The curve panel's property list only shows properties derived from existing clip events. Users can't create a property that has no events yet. Add a `[name input][+]` row pinned at the bottom of the property list; clicking `+` creates the property by appending one event (value 0) at the clip head. No-op if the property already exists.

Decisions (confirmed with user):
- Target clip: the first shown clip (min `offset`) only.
- UI: pinned at the bottom of the props pane, outside the scroll area.

## Design

A "property" is derived from events (`buildProperties` in `curveModel.ts`); creating one = appending one `OscEvent` to the target clip's edit overlay. Reuse the existing `onPointAdd` path (`addPoints` in `src/shared/edits.ts`, undo via `commit`) — no new edit op needed.

New event:
- `t: clip.trimIn` (clip-local head), `a: <name>`, `args: [0]`, `types: 'f'`
- `port`: first event's port in the target clip; else first event of any shown clip; else `defaultPort` prop (App passes `ports.listen`)
- `sel`: `{ file: clip.file, eventIndex: events.length + (edits[file]?.add?.length ?? 0), argIndex: 0 }` — same index rule as `makeAdd` in `useCurveInteraction.ts`

Name rules (pure helper, unit-tested):
- trim; prepend `/` when missing; reject empty, inner whitespace, and `/vtr` prefix (tap control namespace)
- duplicate = `curves` (not `shown` — filter must not hide dupes) already has a property whose address part of `key` equals the name → `+` disabled / no-op

## Changes

### 1. `src/renderer/src/components/curveModel.ts` — pure helpers
- `normalizePropName(raw: string): string | null` — trim, prepend `/`, validate; null when invalid.
- `hasProperty(curves: Property[], addr: string): boolean` — any `p.key` whose address part (`key` is `"${addr} ${argIdx}"`) equals addr.
- `newPropertyAdd(clip, events, addCount, addr, port): PointAdd`-shaped builder (or keep it inline in CurvePanel if it needs `PointAdd` type; put the testable parts here).

### 2. `src/renderer/src/components/CurvePanel.tsx`
- New prop `defaultPort: number`.
- In the props pane: wrap the current filter+rows in a scrollable `.curve-prop-list` div; below it add the pinned row:
  ```tsx
  <div className="curve-prop-add">
    <input value={draft} placeholder="/new/property" aria-label="new property name" ... />
    <button className="btn small" aria-label="add property" disabled={!valid} onClick={addProperty}>
      <Plus size={14} />
    </button>
  </div>
  ```
- Enter in the input triggers add too; input clears on success.
- `addProperty()`: normalize name → bail if invalid/duplicate/no clips → pick target clip = min-offset shown clip with loaded events → build the `PointAdd` → `onPointAdd([add], true)` (commits "1 point added", selects the point — existing behavior).
- The pane `onKeyDown` Delete guard already ignores text inputs (`isTextInput`), so the input is safe.

### 3. `src/renderer/src/App.tsx`
- Pass `defaultPort={ports.listen}` to `<CurvePanel>`. No other changes (reuses `onPointAdd`).

### 4. `src/renderer/src/assets/main.css`
- `.curve-props` → `display: flex; flex-direction: column` (keep `flex: 0 0 180px`); move `overflow-y: auto` to new `.curve-prop-list { flex: 1 }`.
- `.curve-prop-add`: row layout, `border-top: 1px solid var(--border)`, input styled like `.curve-filter`.

## Tests

- Unit (`curveModel.test.ts`): `normalizePropName` (trim, `/` prepend, rejects empty / spaces / `/vtr*`), `hasProperty`, event-building (t = trimIn, args [0], types 'f', eventIndex rule, port fallback).
- E2E (`e2e/curve.spec.ts`): select clip → type name → click `+` → `expectPropCounts(page, '/newthing', 1, 0)`; duplicate name → `+` disabled; verify `.edits.json` sidecar `add` has the event.

## Verification

```sh
cd vtr-editor
npm run typecheck && npm run lint
npx vitest run src/renderer/src/components/curveModel.test.ts
npm run test:e2e   # or: npx playwright test e2e/curve.spec.ts (build out/ + debug vtr-tap first)
```

Manual: `./run` with a project, select clip, add `/foo` → new row in list, one point at clip head, undo removes it, re-adding same name does nothing.
