# Recording stats in the UI + per-clip loss warnings

Status: implemented (2026-07-17), pending commit/PR.

## Background

vtr-tap can lose packets at two points, both invisible in the UI today:

1. **Kernel recv buffer overflow** — the kernel silently drops datagrams when
   the recv thread stalls (CPU starvation). Not detectable per-socket on
   macOS/Windows; only global OS counters exist. Out of scope here — a future
   task may surface OS network stats in the UI.
2. **Writer backlog drop** — the recv→writer bounded channel (cap 65,536) is
   full, `try_send` fails, `dropped` increments. Deliberate design: dropping
   keeps forwarding real-time instead of degrading into (1). Rare in practice
   (the cap is ~9 min at 120 Hz); when it fires, events are definitely missing
   from the clip.

Additionally `write_error` / `write_errors` latch JSONL write failures (disk
full / dead disk) per clip. All these counters reset on clip start and were
lost once the next recording began — nothing recorded that a clip was damaged.

Decisions from the design discussion:

- No status bar. Two surfaces only: header stats (live) and warnings on the
  clip itself (per-recording, persistent).
- Warnings are **state, not events**: they stay visible while the condition
  holds, never auto-dismiss (no toasts).
- `dropped` is rare and serious (same class as write errors), so it is
  included in the per-clip warning, not just the header.
- Per-clip damage must survive reload, so it is persisted **in the clip's
  JSONL** (project.json never stores clip summaries; they are recomputed from
  the JSONL on load).

## Spec

### vtr-tap

- `Status` gains `received: u64` — datagrams received on the listen socket
  since process start, recording or not (`events` only moves while recording,
  so a live receive rate needs this).
- On clip stop, the writer appends a summary line right before `session_end`:

  ```json
  {"type":"summary","t":12.3,"events":1440,"dropped":0,"write_errors":0}
  ```

  `write_error` (string) is included only when a write failed; `events` is the
  count of successfully written events (a truncation check for readers).
  Best-effort: on a dead disk the summary write itself may fail.

### Editor — header stats (live)

In the header-right `status-grid`, second row:

- `rx N/s` — receive rate derived in the renderer from `received` deltas
  between 1 s status polls (`–` until two samples; skipped across tap
  restarts, i.e. negative deltas; tolerates a stale tap without the field).
- `dropped N` — always visible now (was: only when > 0); `chip bad` styling
  when > 0.

### Editor — clip warnings (persistent)

- `readClip` parses the summary line into `ClipSummary.dropped` /
  `writeErrors` / `writeError` (zeros/null for pre-summary clips, which are
  treated as clean). Unknown `type` lines are now skipped instead of being
  counted as events (forward compat).
- A clip whose summary has `dropped > 0 || writeErrors > 0` renders with a
  warning style + `⚠` marker in the clip meta; the tooltip carries the full
  text (`recording lost data: N dropped, M write failures — <error>`).
- The live recording row shows the same warning from `TapStatus` while
  recording, so damage is visible the moment it happens.

## Out of scope (future)

- Kernel-level drop detection (OS network stats in the UI; global counters
  give a sound "no loss" certificate when the delta is zero).
- Sender-side sequence-number probes for measuring network-path loss
  (TouchOSC/MaxMSP → vtr-tap) during rehearsal; post-session gap analysis of
  clip JSONL.
- Forward-path (vtr-tap → TD) delivery counters.
