import json

import numpy as np

from vtr_core import session


def write(tmp_path, lines, name="session.jsonl"):
    p = tmp_path / name
    p.write_text("\n".join(json.dumps(l) if not isinstance(l, str) else l for l in lines) + "\n")
    return p


def ev(t, a="/fader", args=None, types=None, port=10010):
    args = [0.5] if args is None else args
    if types is None:
        types = "f" * len(args)
    return {"t": t, "port": port, "a": a, "types": types, "args": args}


HEADER = {"type": "session_start", "t": 0.0, "routes": ["10010->10011"]}


def test_header_routes_and_trailer_duration(tmp_path):
    s = session.load(write(tmp_path, [HEADER, ev(0.5), ev(1.0), {"type": "session_end", "t": 40.0}]))
    assert s.routes == {10010: 10011}
    assert s.duration == 40.0
    assert len(s) == 2
    assert s.skipped == 0


def test_duration_falls_back_to_last_event(tmp_path):
    s = session.load(write(tmp_path, [HEADER, ev(0.5), ev(2.5)]))
    assert s.duration == 2.5


def test_empty_session(tmp_path):
    s = session.load(write(tmp_path, [HEADER]))
    assert len(s) == 0
    assert s.duration == 0.0
    assert s.addr_events == []


def test_numeric_args_round_trip_with_int_tags(tmp_path):
    s = session.load(write(tmp_path, [ev(0.1, types="fih", args=[0.25, 3, 7])]))
    args = s.event_args(0)
    assert args == [0.25, 3, 7]
    assert isinstance(args[0], float)
    assert isinstance(args[1], int)
    assert isinstance(args[2], int)


def test_non_numeric_args_kept_verbatim(tmp_path):
    s = session.load(write(tmp_path, [ev(0.1, types="sf", args=["cue", 1.5]), ev(0.2)]))
    assert s.event_args(0) == ["cue", 1.5]
    assert s.event_args(1) == [0.5]
    assert 0 in s.raw_args and 1 not in s.raw_args


def test_malformed_lines_are_counted_not_fatal(tmp_path):
    s = session.load(
        write(tmp_path, ["not json", {"t": 1.0, "a": "/x"}, ev(0.5), {"type": "future_thing"}])
    )
    assert len(s) == 1  # ev(0.5)
    assert s.skipped == 2  # garbage + missing port; unknown control line tolerated silently


def test_event_addr_and_per_address_index(tmp_path):
    s = session.load(
        write(tmp_path, [ev(0.1, a="/a"), ev(0.2, a="/b", port=10020), ev(0.3, a="/a")])
    )
    assert s.event_addr(1) == ("/b", 10020)
    assert len(s.addrs) == 2
    ia = s.addrs.index(("/a", 10010))
    assert list(s.addr_events[ia]) == [0, 2]
    assert list(s.addr_t[ia]) == [0.1, 0.3]


def test_unsorted_input_is_reordered(tmp_path):
    s = session.load(write(tmp_path, [ev(2.0, args=[2.0]), ev(1.0, args=[1.0], types="s")]))
    assert list(s.t) == [1.0, 2.0]
    assert s.event_args(0) == [1.0]  # raw_args remapped with the sort
    assert s.event_args(1) == [2.0]
    assert np.all(np.diff(s.addr_t[0]) >= 0)
