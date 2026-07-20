"""Playback state resolver: turns a playhead position into OSC emissions.

No TouchDesigner imports. Two modes per spec (docs/tasks/td/spec.md):

- Continuous forward (0 < step <= jump_threshold): event pump — every event in
  (prev, pos] in order, full fidelity, triggers fire.
- Anything else (first step after reset, forward jump, backward move): seek —
  per-address catch-up to the last value <= pos, one message per address,
  triggers suppressed. Steps with a known previous state only re-resolve the
  addresses touched in between, so frame-by-frame reverse scrubbing stays cheap.

An address with no event <= pos emits nothing on seek: its pre-session state is
unknowable from the file.
"""

from __future__ import annotations

from typing import Callable

import numpy as np

# NOTE: no `from .session import Session` — inside TD these modules load as
# sibling DATs via mod(), where relative imports don't exist. The session
# argument is duck-typed; annotations stay lazy via __future__.annotations.

# (listen port, address, args) — the caller maps port through routes and sends.
Emit = tuple[int, str, list]


class Resolver:
    def __init__(
        self,
        session: "Session",  # noqa: F821 — duck-typed vtr_core.session.Session
        trigger_matcher: Callable[[str], bool] | None = None,
        jump_threshold: float = 0.5,
    ):
        self.session = session
        self.jump_threshold = jump_threshold
        self._is_trigger = [
            bool(trigger_matcher(addr)) if trigger_matcher else False
            for addr, _port in session.addrs
        ]
        self._prev: float | None = None

    def reset(self) -> None:
        """Forget the previous position; the next step() seeks from scratch."""
        self._prev = None

    def step(self, pos: float) -> list[Emit]:
        s = self.session
        prev = self._prev
        self._prev = pos
        if not len(s):
            return []
        if prev is None:
            return self._catchup(pos, addr_ids=range(len(s.addrs)))
        if pos == prev:
            return []
        if pos < prev:
            return self._catchup(pos, addr_ids=self._touched(pos, prev))
        if pos - prev > self.jump_threshold:
            return self._catchup(pos, addr_ids=self._touched(prev, pos))
        return self._pump(prev, pos)

    def _emit(self, i: int) -> Emit:
        s = self.session
        addr, port = s.event_addr(i)
        return (port, addr, s.event_args(i))

    def _pump(self, prev: float, pos: float) -> list[Emit]:
        s = self.session
        lo = int(np.searchsorted(s.t, prev, side="right"))
        hi = int(np.searchsorted(s.t, pos, side="right"))
        return [self._emit(i) for i in range(lo, hi)]

    def _touched(self, t0: float, t1: float):
        """Addresses with at least one event in (t0, t1]."""
        s = self.session
        lo = int(np.searchsorted(s.t, t0, side="right"))
        hi = int(np.searchsorted(s.t, t1, side="right"))
        return np.unique(s.addr_id[lo:hi])

    def _catchup(self, pos: float, addr_ids) -> list[Emit]:
        s = self.session
        chosen: list[int] = []
        for k in addr_ids:
            if self._is_trigger[k]:
                continue
            j = int(np.searchsorted(s.addr_t[k], pos, side="right")) - 1
            if j >= 0:
                chosen.append(int(s.addr_events[k][j]))
        chosen.sort()  # deterministic, time-ordered
        return [self._emit(i) for i in chosen]
