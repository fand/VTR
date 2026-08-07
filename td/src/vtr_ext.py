"""VTRExt — extension for vtr.tox (protocol v2 client). TouchDesigner-only code.

The tox is a thin client with no modes: no session parsing, no resolver, no
rec awareness. Every frame it does the same two things.

- clock beacon: send `/vtr/clock [t rate]` to the tap's listen port so
  recorded events carry TD-timeline time. The Clock toggle gates it.
- player tick: block on one resolve query to vtr-player's unix socket and
  apply the delta before the frame cooks.

The position source is picked from TD's realtime flag (`project.realTime`):

- realtime on (live): bidirectional sync glue to the player's push
  transport — seeking in TD or in the editor propagates both ways. Short
  query timeout, so a hung player costs one hiccup, not a stalled frame.
- realtime off (Export Movie): resolve at the TD timeline seconds minus
  Offset; the transport is never read or written. Long timeout — a render
  must never skip a frame's events. Deterministic by construction.

Recording is triggered from a controller or the editor, never from TD. Rec
follow needs no special case here: vtr-player primes and starts its
transport on rec start (`tap_client.rs`), and the sync glue below sees that
as an ordinary foreign move.

Spec: docs/tasks/tox-rework/spec.md + plan.md; sync: docs/tasks/tl-sync/;
single mode: docs/tasks/tox-single-mode/.
"""

import json
import os
import socket
import time
import traceback

# Blocking-read budget for one player reply, per branch. Offline rendering
# must never skip a frame's events, so slow is acceptable there and only a
# dead player should trip it. Live TD must not stall a whole frame on a hung
# player, so it gives up fast and retries on the reconnect throttle.
QUERY_TIMEOUT_LIVE_S = 0.1
QUERY_TIMEOUT_RENDER_S = 5.0
# Throttle reconnect attempts after a socket failure.
RECONNECT_S = 1.0
# Paused-timeline tick rate. onFrameStart stops when the TD timeline is
# paused; the delayed-run queue does not, so a self-rescheduling heartbeat
# keeps player sync and the clock beacon alive through a pause.
HEARTBEAT_MS = 50

# Live sync: TD is glued to the player transport both ways. TD gives no
# scrub-gesture event, so a user seek is inferred from a discontinuity
# between the timeline and the transport.
# JUMP: a gap this large (seconds) is a deliberate seek — write it back.
SYNC_JUMP_EPS = 0.25
# DRIFT: below this (frames) the timeline is silently re-glued to the
# transport; never written back (frame quantization + wall-clock drift).
SYNC_DRIFT_FRAMES = 2.0


class VTRExt:
    def __init__(self, ownerComp):
        self.ownerComp = ownerComp
        # clock beacon
        self._last_clock = float("-inf")  # absTime of the last /vtr/clock
        # player client
        self.sock = None
        self.rfile = None
        self.error = ""
        self._rows = {}  # (port, addr) -> state DAT row
        self._pending_load = False
        self._next_connect = 0.0  # absTime gate on reconnect attempts
        self._realtime = None  # last seen project.realTime; None forces an edge
        self._sync_reset()  # live sync state
        self._reset_state()
        if str(self.ownerComp.par.File.eval()).strip():
            self._pending_load = True
        self._set_info("connected", "0")
        self._set_info("error", "")
        # Generation stamp kills the previous instance's heartbeat loop
        # after a re-init (extension reload, comp copy/paste).
        self._gen = int(self.ownerComp.fetch("vtr_hb_gen", 0)) + 1
        self.ownerComp.store("vtr_hb_gen", self._gen)
        self._schedule_heartbeat()

    # ------------------------------------------------------------------ util

    def _timeout(self):
        """Query timeout for the branch this tick runs (see the constants)."""
        return QUERY_TIMEOUT_LIVE_S if self._realtime else QUERY_TIMEOUT_RENDER_S

    def _timeline(self):
        """(t, rate) of the root timeline. TD plays in real time, so rate is
        1 while playing and 0 while paused — the beacon speed, not the FPS."""
        t = op("/").time  # noqa: F821
        return float(t.seconds), (1.0 if t.play else 0.0)

    def _tap(self):
        return self.ownerComp.op("oscout_tap")

    def _set_info(self, key, value):
        dat = self.ownerComp.op("info")
        if dat is None:
            return
        for r in range(1, dat.numRows):
            if dat[r, 0] == key:
                dat[r, 1] = str(value)
                return
        dat.appendRow([key, str(value)])

    # ------------------------------------------------------------- callbacks

    def OnFrame(self):
        """Called every frame (Execute DAT, frameStart) — before the cook."""
        self._clock_tick()
        self._player_tick()

    def Heartbeat(self):
        """Paused-timeline tick. While the timeline plays, onFrameStart
        covers everything and this only reschedules itself."""
        if self._gen != int(self.ownerComp.fetch("vtr_hb_gen", 0)):
            return  # superseded by a newer extension init
        self._schedule_heartbeat()
        if op("/").time.play:  # noqa: F821
            return
        self.OnFrame()

    def _schedule_heartbeat(self):
        # delayMilliSeconds: capital S (the lowercase form is a tdError).
        # delayRef=TDResources: its clock keeps counting while the main
        # timeline is paused — the whole point of this heartbeat.
        try:
            run(
                "args[0].Heartbeat()",
                self,
                delayMilliSeconds=HEARTBEAT_MS,
                delayRef=op.TDResources,  # noqa: F821
            )
        except Exception:
            # A dead heartbeat must be loud: swallowing this hid the
            # misspelled kwarg for a whole debugging round.
            print("VTR: heartbeat scheduling failed:")
            traceback.print_exc()

    def OnParChange(self, par):
        """Called from the Parameter Execute DAT."""
        name = par.name
        if name in ("File", "Triggerpatterns"):
            # Trigger classification is compiled into the server-side load.
            self._pending_load = True
        elif name == "Sockpath":
            # Pointing at another player: reconnect lazily. A fresh
            # connection re-baselines server-side, so the next resolve is a
            # full catch-up.
            self._disconnect()

    def OnPulse(self, par):
        if par.name == "Reload":
            self._pending_load = True

    # ----------------------------------------------------------------- clock

    def _clock_tick(self):
        p = self.ownerComp.par
        if not p.Clock.eval():
            return
        # Wall clock, not absTime: the beacon must keep its rate while the
        # timeline is paused (absTime freezes with it).
        now = time.monotonic()
        hz = max(0.1, float(p.Clockrate.eval()))
        if now - self._last_clock < 1.0 / hz:
            return
        self._last_clock = now
        t, rate = self._timeline()
        # Sent also while paused (rate 0): beacon age keeps tl stamping alive.
        self._tap().sendOSC("/vtr/clock", [t, rate])

    # ---------------------------------------------------------------- player

    def _player_tick(self):
        p = self.ownerComp.par
        realtime = bool(project.realTime)  # noqa: F821
        if realtime != self._realtime:
            # Branch edge. Drop the sync baseline — coming back to realtime
            # re-adopts the transport and writes nothing — and re-arm the
            # live socket with this branch's timeout.
            self._realtime = realtime
            self._sync_reset()
            if self.sock is not None:
                try:
                    self.sock.settimeout(self._timeout())
                except Exception as e:
                    self._drop_socket("{}".format(e))
                    return
        if not self._ensure_connected():
            return  # degraded: state freezes on the last applied values
        try:
            if self._pending_load:
                self._load()
            if realtime:
                self._sync_tick(p)
                return
            # Offline render: the TD timeline is the position source and the
            # transport is neither read nor written — same session, same
            # frames, every run.
            pos = float(op("/").time.seconds) - float(p.Offset.eval())  # noqa: F821
            reply = self._request({"cmd": "resolve", "t": pos})
        except Exception as e:
            self._drop_socket("{}".format(e))
            return
        if not reply.get("ok"):
            # e.g. "no session loaded" after a player restart with no File
            # set; not a socket problem, so stay connected.
            self._set_error(reply.get("error", "resolve failed"))
            return
        self._set_error("")
        self._apply(reply.get("events", []))

    def _sync_reset(self):
        """Drop the sync baseline: the next sync tick adopts the transport
        state wholesale and writes nothing (branch edge, reconnect)."""
        self._sync_gen = -1  # last transport gen applied
        self._sync_last = None  # (td_seconds, play, monotonic) at last tick
        self._sync_reseed = False  # error-driven drops set this (see _drop_socket)

    def _sync_tick(self, p):
        """Bidirectional glue between the root timeline and the player
        transport. TD gives no scrub event, so user gestures are inferred
        from a discontinuity against the position this extension *expects*
        the timeline to be at (last tick's position, advanced while it was
        playing) — never against the transport itself, which would misread
        every foreign move as a local gesture."""
        tl = op("/").time  # noqa: F821
        rate = float(tl.rate) or 60.0
        offset = float(p.Offset.eval())
        actual_td = float(tl.seconds)
        actual_play = bool(tl.play)
        now = time.monotonic()

        # 0. First tick after an error-driven reconnect (player crash):
        #    during the outage TD was the only live timeline the operator
        #    saw, so seed the transport from it (origin "td") instead of
        #    adopting — a restarted player would otherwise yank TD to
        #    0/stopped. Seeding happens before the resolve so this frame
        #    already resolves at the reseeded playhead. A live foreign
        #    driver still wins: the hold rule rejects these writes and the
        #    adopt below snaps to the transport as usual.
        if self._sync_last is None and self._sync_reseed:
            self._sync_reseed = False
            r = self._request({"cmd": "seek", "t": actual_td - offset, "origin": "td"})
            if (
                r.get("ok")
                and str(r.get("origin", "")) == "td"
                and bool(r.get("playing")) != actual_play
            ):
                self._request({"cmd": "play" if actual_play else "stop", "origin": "td"})

        reply = self._request({"cmd": "resolve", "follow": True})
        if not reply.get("ok"):
            self._set_error(reply.get("error", "resolve failed"))
            return
        self._set_error("")
        t = float(reply.get("t", 0.0))
        tr_play = bool(reply.get("playing"))
        gen = int(reply.get("gen", 0))
        origin = str(reply.get("origin", ""))

        # 1. User gestures → write back (origin "td"). The first tick after
        #    entry/reconnect has no baseline: adopt the transport, never
        #    write. Each write reply is the authoritative outcome — the
        #    hold rule may reject it mid-drag on the other side — so fold
        #    it back in before the apply step.
        user_seek = user_play = False
        if self._sync_last is not None:
            last_td, last_play, last_mono = self._sync_last
            expected_td = last_td + ((now - last_mono) if last_play else 0.0)
            user_seek = abs(actual_td - expected_td) > SYNC_JUMP_EPS
            user_play = actual_play != last_play
        if user_seek:
            r = self._request({"cmd": "seek", "t": actual_td - offset, "origin": "td"})
            if r.get("ok"):
                t = float(r.get("playhead", t))
                tr_play = bool(r.get("playing"))
                gen, origin = int(r.get("gen", gen)), str(r.get("origin", ""))
        if user_play:
            r = self._request({"cmd": "play" if actual_play else "stop", "origin": "td"})
            if r.get("ok"):
                t = float(r.get("playhead", t))
                tr_play = bool(r.get("playing"))
                gen, origin = int(r.get("gen", gen)), str(r.get("origin", ""))
        target_td = t + offset

        # 2. Glue the timeline to the transport. `lost` = this tick's
        #    gesture was rejected by the hold rule (a foreign writer holds
        #    the transport): snap back and keep following — without this a
        #    rejected drag would leave the timeline diverged forever.
        lost = (user_seek or user_play) and origin != "td"
        foreign = gen != self._sync_gen and origin != "td"
        if self._sync_last is None or lost or foreign:
            tl.frame = target_td * rate + 1.0
            tl.play = tr_play
        elif tr_play and abs(actual_td - target_td) > SYNC_DRIFT_FRAMES / rate:
            # Frame quantization / wall-clock drift: silent correction,
            # never written back.
            tl.frame = target_td * rate + 1.0
        self._sync_gen = gen
        # Next tick's prediction starts from what the timeline actually
        # shows now (frame assignment quantizes).
        self._sync_last = (float(tl.seconds), bool(tl.play), now)

        self._apply(reply.get("events", []))

    def _ensure_connected(self):
        if self.sock is not None:
            return True
        now = time.monotonic()  # wall clock: retries must run while paused
        if now < self._next_connect:
            return False
        path = os.path.expanduser(str(self.ownerComp.par.Sockpath.eval()).strip())
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            # TD's embedded Python leaves SIGPIPE at its default (terminate),
            # unlike the CPython binary. A sendall after the player dies
            # (VTR quit, or the player restart on project open) would then
            # kill the whole TD process — SO_NOSIGPIPE turns that into an
            # EPIPE exception, handled by _drop_socket. TD's Python does not
            # export the constant, so use the darwin value (0x1022) directly;
            # this client is macOS-only anyway (AF_UNIX).
            s.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_NOSIGPIPE", 0x1022), 1)
            s.settimeout(self._timeout())
            s.connect(path)
        except Exception as e:
            self._next_connect = now + RECONNECT_S
            self._set_error("connect {}: {}".format(path, e))
            return False
        self.sock = s
        self.rfile = s.makefile("r", encoding="utf-8")
        self._set_error("")
        self._set_info("connected", "1")
        # Self-healing render setups: a File names the session this client
        # wants, so (re)load it on every fresh connection — a restarted
        # player comes back empty. The load swaps the player's single
        # global session and stops its push transport.
        if str(self.ownerComp.par.File.eval()).strip():
            self._pending_load = True
        return True

    def _request(self, obj):
        data = (json.dumps(obj) + "\n").encode("utf-8")
        self.sock.sendall(data)
        line = self.rfile.readline()
        if not line:
            raise ConnectionError("player closed the connection")
        return json.loads(line)

    def _load(self):
        p = self.ownerComp.par
        path = os.path.expanduser(str(p.File.eval()).strip())
        triggers = str(p.Triggerpatterns.eval()).split()
        # One shot per pulse/change: a failing load must not retry (and
        # spam) every frame. Re-pulse Reload after fixing the cause.
        self._pending_load = False
        if not path:
            return
        reply = self._request({"cmd": "load", "path": path, "triggers": triggers})
        if not reply.get("ok"):
            self._set_error(reply.get("error", "load failed"))
            return
        self._reset_state()
        for key in ("duration", "events", "addresses", "skipped"):
            self._set_info(key, reply.get(key, ""))
        self._set_info("session", path)
        self._set_error("")

    # ----------------------------------------------------------------- apply

    def _apply(self, events):
        if not events:
            return
        self._apply_state(events)
        self._apply_chop(events)
        self._fire_callbacks(events)

    def _apply_state(self, events):
        dat = self.ownerComp.op("state")
        if dat is None:
            return
        for port, addr, args in events:
            cells = [str(port), str(addr)] + [self._fmt(a) for a in args]
            while dat.numCols < len(cells):
                dat.appendCol([""] * dat.numRows)
            row = self._rows.get((port, addr))
            if row is None:
                self._rows[(port, addr)] = dat.numRows
                dat.appendRow(cells + [""] * (dat.numCols - len(cells)))
            else:
                for i in range(dat.numCols):
                    dat[row, i] = cells[i] if i < len(cells) else ""

    @staticmethod
    def _fmt(arg):
        # Ints stay ints so DAT-to-CHOP consumers don't see "3.0".
        if isinstance(arg, float) and arg.is_integer():
            return str(int(arg))
        return str(arg)

    # ------------------------------------------------------------------- chop

    def _apply_chop(self, events):
        """Fold numeric args into the CHOP channel map, then re-cook.

        The `chop_out` Script CHOP is the numeric sibling of the state DAT:
        one channel per numeric OSC argument, holding its latest value —
        wire it straight into TD without a DAT-to-CHOP. String args have no
        CHOP representation and are skipped (read them from the state DAT).
        Cooking a Script CHOP is pull-driven and TD caches it, so a live
        output has to be dirtied every frame it changes — force the cook
        here, only when something actually moved.
        """
        chop = self.ownerComp.op("chop_out")
        if chop is None:
            return
        changed = False
        for _port, addr, args in events:
            nums = [a for a in args if isinstance(a, (int, float))]
            if not nums:
                continue
            if len(nums) == 1:
                self._chan[addr] = float(nums[0])
            else:
                # Multi-arg addresses fan out to addr:0, addr:1, … so a
                # channel name never collides with a real sibling address.
                for i, v in enumerate(nums):
                    self._chan["{}:{}".format(addr, i)] = float(v)
            changed = True
        if changed:
            chop.cook(force=True)

    def FillChop(self, scriptOp):
        """onCook hook for the `chop_out` Script CHOP: one sample per
        channel, keyed by OSC address (last value wins across ports)."""
        scriptOp.clear()
        scriptOp.numSamples = 1
        for name, val in self._chan.items():
            scriptOp.appendChan(name)[0] = val

    def _fire_callbacks(self, events):
        dat = self.ownerComp.op("callbacks")
        if dat is None:
            return
        try:
            fn = getattr(dat.module, "onEvents", None)
            if fn:
                fn(events)
        except Exception:
            print("VTR: callbacks onEvents failed:")
            traceback.print_exc()

    def _reset_state(self):
        self._rows = {}
        self._chan = {}
        dat = self.ownerComp.op("state")
        if dat is not None:
            dat.clear()
            dat.appendRow(["port", "addr"])
        chop = self.ownerComp.op("chop_out")
        if chop is not None:
            chop.cook(force=True)

    # ------------------------------------------------------ player plumbing

    def _set_error(self, msg):
        if msg == self.error:
            return
        self.error = msg
        self._set_info("error", msg)
        if msg:
            print("VTR:", msg)

    def _disconnect(self):
        for f in (self.rfile, self.sock):
            if f is not None:
                try:
                    f.close()
                except Exception:
                    pass
        self.rfile = None
        self.sock = None
        # A reconnect re-baselines from the transport, no write-back —
        # unless _drop_socket flags an error-driven drop for reseeding.
        self._sync_reset()
        self._set_info("connected", "0")

    def _drop_socket(self, msg):
        self._disconnect()
        # Error-driven drop (player crash, dead socket): after the
        # reconnect, live sync reseeds the transport from TD instead of
        # adopting. Deliberate drops (Sockpath change) keep the
        # adopt-on-entry behavior from _disconnect alone.
        self._sync_reseed = True
        self._set_error(msg)
        self._next_connect = time.monotonic() + RECONNECT_S
