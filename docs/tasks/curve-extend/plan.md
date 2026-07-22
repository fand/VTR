# Plan: curve-extend — extend values before an address's first data point

Status: done. (The Python reference in items 1–2 was removed before
implementation; the Rust resolver + conformance suite carry the change.)

## Goal

Seeking before an address's first event should resolve to that first event's
value, the way DAW automation extends a curve flat to the left of its first
point. Example from TODO.md: a curve with data points in t=10–20 must resolve
t=1 to the same value as t=10.

## Current state

- Both resolvers implement the opposite rule, explicitly: "an address with
  no event <= pos emits nothing on seek: its pre-session state is unknowable
  from the file" (`td/src/vtr_core/resolver.py:12`,
  `vtr-tap/vtr-player/src/resolver.rs:14`, `docs/tasks/td/spec.md` Seek
  bullet). Implementation-wise it is the `j < 0` skip in `_catchup` /
  `catchup` after the `searchsorted(pos, right) - 1` lookup.
- Every playback path goes through the one resolver in vtr-player (editor
  preview, file replay, TD `resolve` queries — see
  `docs/tasks/unify-resolver/plan.md`, whose follow-ups section already
  points this TODO item at the resolver). `td/src/vtr_core` is the
  executable conformance reference; `td/tests/test_resolver.py` defines the
  semantics and is ported 1:1 to
  `vtr-tap/vtr-player/tests/conformance_resolver.rs`.
- Repeated-seek dedup already exists: the player wraps every connection's
  resolver in `DedupResolver` (emit loop and `resolve` connections), which
  drops catch-up emissions exactly equal to the per-connection last-emitted
  value. The TODO's "avoid re-sending duplicates on continuous seeks"
  concern is satisfied by that existing layer — no new mechanism needed.
- `session.jsonl` does not distinguish curve-drawn events from recorded
  ones, and the address table is built from events, so every address has at
  least one event: a clamp target always exists.

## Design decision

On seek (catch-up), when `pos` is earlier than an address's first event,
clamp to the first event and emit its value. This applies to every
non-trigger address, not just "curves" — the format cannot tell them apart,
and first-value extension is the natural automation semantic for recorded
clips too. Trigger addresses stay suppressed on seek, as today.

Consequences, accepted:

- The backward-scrub optimization (`_touched`) stays correct unchanged: the
  extended region's value equals the first event's value, a constant, so an
  address that is not re-resolved on a backward step already holds the
  right value at the receiver.
- After a transport start, the initial seek now emits the first value of a
  not-yet-reached address; when the pump later crosses that first event it
  re-sends the same value (pump is full-fidelity, never deduped). One
  duplicate message with an identical value — harmless.
- A full catch-up (first step after reset/load) now emits one message for
  every non-trigger address in the session, including addresses whose
  events are all in the future. That is the point of the change.

## Changes

1. `td/src/vtr_core/resolver.py` — in `_catchup`, clamp `j` to 0 instead of
   skipping when no event is <= pos. Rewrite the module docstring's
   "emits nothing on seek" paragraph to the new rule.
2. `td/tests/test_resolver.py` (semantic source of truth):
   - New: events only in t=10–20; `step(1.0)` emits the t=10 value (the
     TODO example verbatim).
   - New: a trigger address before its first event stays silent on seek.
   - Update `test_backward_reresolves_only_touched_addresses`: `/late`
     (first event t=2.5) was silent at pos=1.0; it now emits its first
     value `[7.0]`.
3. `vtr-tap/vtr-player/src/resolver.rs` — same clamp in `catchup`
   (`j == 0` → take `addr_events[k][0]`), doc comment update. Add a
   `DedupResolver` unit test: repeated seeks before the first data point
   emit the value once, then stay quiet (regression test for the TODO's
   dedup concern).
4. `vtr-tap/vtr-player/tests/conformance_resolver.rs` — port item 2's test
   changes 1:1.
5. Docs — update the Seek bullet in `docs/tasks/td/spec.md`; drop the TODO
   line. README needs no change (it documents the control protocol, not the
   catch-up rule).

## Commits

1. `feat(player): extend values before an address's first event on seek` —
   Rust + Python resolvers and both test suites in one commit, keeping the
   conformance pair atomic (CLAUDE.md: resolver semantic changes must
   update both).
2. `docs: seek now extends values before the first data point` — spec.md +
   TODO.md.

## Verification

- `cd td && uv run pytest`
- `cd vtr-tap && cargo test` (both crates, conformance included)
