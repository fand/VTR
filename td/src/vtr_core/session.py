"""Columnar in-memory model of an exported session.jsonl.

No TouchDesigner imports — this module is pytest-able outside TD. Events are
stored as numpy columns (~20 B/event) so multi-million-event sessions stay in
the hundreds of MB; per-address indexes make seek catch-up a searchsorted.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np

# OSC type tags whose args can live in the shared float pool. Everything else
# (strings, blobs, bools, ...) keeps its parsed args in `raw_args` verbatim.
NUMERIC_TAGS = frozenset("fdih")
INT_TAGS = frozenset("ih")


@dataclass
class Session:
    # Event columns, time-sorted.
    t: np.ndarray  # float64 seconds
    addr_id: np.ndarray  # int32 -> addrs
    types_id: np.ndarray  # int32 -> types_tbl
    arg_off: np.ndarray  # int64 into argpool (0-len for raw events)
    arg_len: np.ndarray  # int32
    argpool: np.ndarray  # float64 pool of numeric args
    raw_args: dict[int, list]  # event index -> args, for non-numeric events
    # Tables.
    addrs: list[tuple[str, int]]  # id -> (address, listen port)
    types_tbl: list[str]
    # Per-address event indices (time-ordered) and their times.
    addr_events: list[np.ndarray]
    addr_t: list[np.ndarray]
    # Header / trailer.
    routes: dict[int, int]  # listen port -> forward port
    duration: float
    skipped: int  # malformed lines dropped during load

    def __len__(self) -> int:
        return len(self.t)

    def event_addr(self, i: int) -> tuple[str, int]:
        """(address, listen port) of event i."""
        return self.addrs[self.addr_id[i]]

    def event_args(self, i: int) -> list:
        """Args of event i, ints restored per the OSC type tags."""
        if i in self.raw_args:
            return list(self.raw_args[i])
        off = int(self.arg_off[i])
        vals = self.argpool[off : off + int(self.arg_len[i])]
        types = self.types_tbl[self.types_id[i]]
        return [int(v) if tag in INT_TAGS else float(v) for tag, v in zip(types, vals)]


def _parse_routes(routes) -> dict[int, int]:
    out: dict[int, int] = {}
    for r in routes or []:
        try:
            src, dst = str(r).split("->")
            out[int(src)] = int(dst)
        except ValueError:
            continue
    return out


def load(path) -> Session:
    """Load a session.jsonl. Malformed lines are counted, never fatal."""
    ts: list[float] = []
    addr_ids: list[int] = []
    types_ids: list[int] = []
    offs: list[int] = []
    lens: list[int] = []
    pool: list[float] = []
    raw: dict[int, list] = {}
    addr_map: dict[tuple[str, int], int] = {}
    addrs: list[tuple[str, int]] = []
    types_map: dict[str, int] = {}
    types_tbl: list[str] = []
    routes: dict[int, int] = {}
    duration: float | None = None
    skipped = 0

    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue
            if not isinstance(obj, dict):
                skipped += 1
                continue
            typ = obj.get("type")
            if typ == "session_start":
                routes = _parse_routes(obj.get("routes"))
                continue
            if typ == "session_end":
                if isinstance(obj.get("t"), (int, float)):
                    duration = float(obj["t"])
                continue
            if typ is not None:  # unknown control line: tolerate for forward compat
                continue
            try:
                t = float(obj["t"])
                port = int(obj["port"])
                addr = str(obj["a"])
            except (KeyError, TypeError, ValueError):
                skipped += 1
                continue
            args = obj.get("args") or []
            types = str(obj.get("types") or "")

            key = (addr, port)
            aid = addr_map.get(key)
            if aid is None:
                aid = addr_map[key] = len(addrs)
                addrs.append(key)
            tid = types_map.get(types)
            if tid is None:
                tid = types_map[types] = len(types_tbl)
                types_tbl.append(types)

            i = len(ts)
            ts.append(t)
            addr_ids.append(aid)
            types_ids.append(tid)
            numeric = (
                len(types) == len(args)
                and all(tag in NUMERIC_TAGS for tag in types)
                and all(isinstance(a, (int, float)) and not isinstance(a, bool) for a in args)
            )
            if numeric:
                offs.append(len(pool))
                lens.append(len(args))
                pool.extend(float(a) for a in args)
            else:
                offs.append(0)
                lens.append(0)
                raw[i] = args

    t_arr = np.asarray(ts, dtype=np.float64)
    addr_arr = np.asarray(addr_ids, dtype=np.int32)
    types_arr = np.asarray(types_ids, dtype=np.int32)
    off_arr = np.asarray(offs, dtype=np.int64)
    len_arr = np.asarray(lens, dtype=np.int32)

    # Exports are time-sorted already; reorder defensively if not.
    if len(t_arr) and np.any(np.diff(t_arr) < 0):
        order = np.argsort(t_arr, kind="stable")
        inv = {int(old): new for new, old in enumerate(order)}
        raw = {inv[i]: a for i, a in raw.items()}
        t_arr = t_arr[order]
        addr_arr = addr_arr[order]
        types_arr = types_arr[order]
        off_arr = off_arr[order]
        len_arr = len_arr[order]

    if len(addrs):
        by_addr = np.argsort(addr_arr, kind="stable")
        counts = np.bincount(addr_arr, minlength=len(addrs))
        addr_events = [ix.astype(np.int64) for ix in np.split(by_addr, np.cumsum(counts)[:-1])]
        addr_t = [t_arr[ix] for ix in addr_events]
    else:
        addr_events = []
        addr_t = []

    if duration is None:
        duration = float(t_arr[-1]) if len(t_arr) else 0.0

    return Session(
        t=t_arr,
        addr_id=addr_arr,
        types_id=types_arr,
        arg_off=off_arr,
        arg_len=len_arr,
        argpool=np.asarray(pool, dtype=np.float64),
        raw_args=raw,
        addrs=addrs,
        types_tbl=types_tbl,
        addr_events=addr_events,
        addr_t=addr_t,
        routes=routes,
        duration=duration,
        skipped=skipped,
    )
