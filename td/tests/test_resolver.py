import json

from vtr_core import session
from vtr_core.resolver import Resolver


def load(tmp_path, lines):
    p = tmp_path / "session.jsonl"
    p.write_text("\n".join(json.dumps(l) for l in lines) + "\n")
    return session.load(p)


def ev(t, a="/fader", args=None, port=10010):
    args = [t] if args is None else args
    return {"t": t, "port": port, "a": a, "types": "f" * len(args), "args": args}


def is_kick(addr):
    return addr.startswith("/kick")


def test_first_step_is_full_catchup(tmp_path):
    s = load(tmp_path, [ev(0.1, "/a", [1.0]), ev(0.2, "/b", [2.0]), ev(0.3, "/a", [3.0])])
    r = Resolver(s)
    assert r.step(5.0) == [(10010, "/b", [2.0]), (10010, "/a", [3.0])]


def test_pump_emits_every_event_once_in_order(tmp_path):
    s = load(tmp_path, [ev(1.0), ev(1.1), ev(1.2), ev(1.3)])
    r = Resolver(s)
    r.step(1.0)  # seek lands on the t=1.0 event
    assert [e[2][0] for e in r.step(1.3)] == [1.1, 1.2, 1.3]  # (prev, pos], no coalescing
    assert r.step(1.3) == []  # pos unchanged
    assert r.step(1.4) == []  # nothing new


def test_forward_jump_coalesces_per_address(tmp_path):
    s = load(
        tmp_path,
        [ev(0.0, "/idle", [9.0]), ev(1.0, "/a", [1.0]), ev(1.5, "/a", [2.0]), ev(2.0, "/b", [3.0])],
    )
    r = Resolver(s)
    r.step(0.5)
    # Jump 0.5 -> 3.0: /a coalesced to its last value, /idle untouched -> not re-sent.
    assert r.step(3.0) == [(10010, "/a", [2.0]), (10010, "/b", [3.0])]


def test_backward_reresolves_only_touched_addresses(tmp_path):
    s = load(
        tmp_path,
        [ev(0.5, "/a", [1.0]), ev(2.0, "/a", [2.0]), ev(2.5, "/late", [7.0]), ev(0.6, "/idle", [9.0])],
    )
    r = Resolver(s)
    r.step(3.0)
    # Back to 1.0: /a returns to its 0.5s value; /late has nothing <= 1.0 -> silent;
    # /idle untouched in (1.0, 3.0] -> not re-sent.
    assert r.step(1.0) == [(10010, "/a", [1.0])]


def test_triggers_fire_on_pump_but_not_on_seek(tmp_path):
    s = load(tmp_path, [ev(1.0, "/kick", [1.0]), ev(1.1, "/fader", [0.5])])
    r = Resolver(s, trigger_matcher=is_kick)
    assert r.step(5.0) == [(10010, "/fader", [0.5])]  # seek suppresses the trigger
    r.reset()
    r.step(0.9)
    out = r.step(1.2)  # continuous forward fires it
    assert (10010, "/kick", [1.0]) in out


def test_reset_forces_full_catchup(tmp_path):
    s = load(tmp_path, [ev(0.1, "/a", [1.0])])
    r = Resolver(s)
    r.step(1.0)
    assert r.step(1.1) == []
    r.reset()
    assert r.step(1.2) == [(10010, "/a", [1.0])]


def test_empty_session(tmp_path):
    r = Resolver(load(tmp_path, [{"type": "session_start", "t": 0.0, "routes": []}]))
    assert r.step(1.0) == []


def test_jump_threshold_is_configurable(tmp_path):
    s = load(tmp_path, [ev(1.0), ev(1.5), ev(2.0)])
    r = Resolver(s, jump_threshold=2.0)
    r.step(0.5)
    assert [e[2][0] for e in r.step(2.0)] == [1.0, 1.5, 2.0]  # 1.5s step still pumps
