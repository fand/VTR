"""VTRExt — extension for vtr.tox (protocol v2 client). TouchDesigner-only code.

The tox is a thin client with a Mode switch: no session parsing, no resolver.

- record: TD follows VTR. The tap's rec notifications (`/vtr/rec/start [tl
  rate]` / `/vtr/rec/stop` on Notifyport) seek the root timeline and start
  playback; the clock beacon (`/vtr/clock`) and the Record toggle talk to the
  tap's listen port.
- player: every frame blocks on a resolve query to vtr-player's unix socket
  and applies the delta before the frame cooks. Position source
  (`Positionmode`): the TD timeline (deterministic — offline rendering),
  the player's push-transport playhead (follows the editor preview), or an
  internal transport.

Spec: docs/tasks/tox-rework/spec.md + plan.md.
"""

import json
import os
import socket
import time
import traceback

# Blocking-read budget for one player reply. Generous on purpose: offline
# rendering must never skip a frame's events, so slow is acceptable and only
# a dead player should trip this.
QUERY_TIMEOUT_S = 5.0
# Throttle reconnect attempts after a socket failure.
RECONNECT_S = 1.0
# Paused-timeline tick rate. onFrameStart stops when the TD timeline is
# paused; the delayed-run queue does not, so a self-rescheduling heartbeat
# keeps player sync and the clock beacon alive through a pause.
HEARTBEAT_MS = 50


class VTRExt:
    def __init__(self, ownerComp):
        self.ownerComp = ownerComp
        # record mode
        self._last_clock = float("-inf")  # absTime of the last /vtr/clock
        # player mode
        self.sock = None
        self.rfile = None
        self.routes = {}  # listen port -> forward port, from the load reply
        self.error = ""
        self._rows = {}  # (port, addr) -> state DAT row
        self._pending_load = False
        self._next_connect = 0.0  # absTime gate on reconnect attempts
        self._pos = 0.0  # internal transport position (Positionmode internal)
        self._last_abs = None
        self._oscouts = {}  # (host, port) -> oscout DAT
        self._warned_ports = set()
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

    def _mode(self):
        return str(self.ownerComp.par.Mode.eval())

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
        if self._mode() == "record":
            self._clock_tick()
        else:
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
        if name == "Record":
            if self._mode() != "record":
                return
            t, rate = self._timeline()
            if par.eval():
                self._tap().sendOSC("/vtr/rec/start", [t, rate])
            else:
                self._tap().sendOSC("/vtr/rec/stop", [])
        elif name in ("File", "Triggerpatterns"):
            # Trigger classification is compiled into the server-side load.
            self._pending_load = True
        elif name in ("Mode", "Sockpath"):
            # Leaving player mode, or pointing at another player: reconnect
            # lazily. A fresh connection re-baselines server-side, so the
            # next resolve is a full catch-up.
            self._disconnect()
        elif name in ("Playhost", "Playport"):
            self._drop_outputs()
        elif name in ("Positionmode", "Play"):
            # A jump in the queried t IS the seek; only the internal
            # transport's time base needs resetting.
            self._last_abs = None

    def OnPulse(self, par):
        if par.name == "Rewind":
            self._pos = 0.0
            self._last_abs = None
        elif par.name == "Reload":
            self._pending_load = True

    def OnNotify(self, address, args):
        """Rec notification from the tap (`--td-notify`, plain OSC)."""
        if self._mode() != "record":
            return
        if address == "/vtr/rec/start":
            # Args are omitted when the tap's clock is unknown: start
            # playback without seeking. rate is accepted but unused (v1
            # plays at the timeline's own speed).
            t = op("/").time  # noqa: F821
            if args:
                try:
                    tl = float(args[0])
                except (TypeError, ValueError):
                    tl = None
                if tl is not None:
                    t.frame = tl * t.rate + 1.0
            t.play = True
        elif address == "/vtr/rec/stop":
            # Keep playing: a rec stop is a logging event, not a transport
            # command (plan, resolved 2026-07-21).
            pass

    # ------------------------------------------------------------------- rec

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
        mode = str(p.Positionmode.eval())
        if mode == "follow":
            # Track vtr-player's push transport: the editor preview (or a
            # controller's /vtr/play|seek) drives it, TD follows.
            req = {"cmd": "resolve", "follow": True}
        elif mode == "internal":
            now = absTime.seconds  # noqa: F821
            if not p.Play.eval():
                self._last_abs = None
                return
            if self._last_abs is not None:
                self._pos += now - self._last_abs
            self._last_abs = now
            req = {"cmd": "resolve", "t": self._pos}
        else:  # timeline: the offline-render position source
            pos = float(op("/").time.seconds) - float(p.Offset.eval())  # noqa: F821
            req = {"cmd": "resolve", "t": pos}
        if not self._ensure_connected():
            return  # degraded: state freezes on the last applied values
        try:
            if self._pending_load:
                self._load()
            reply = self._request(req)
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

    def _ensure_connected(self):
        if self.sock is not None:
            return True
        now = time.monotonic()  # wall clock: retries must run while paused
        if now < self._next_connect:
            return False
        path = os.path.expanduser(str(self.ownerComp.par.Sockpath.eval()).strip())
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(QUERY_TIMEOUT_S)
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
        self.routes = {int(k): int(v) for k, v in reply.get("routes", {}).items()}
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
        self._fire_callbacks(events)
        if self.ownerComp.par.Emitosc.eval():
            for port, addr, args in events:
                self._out_for(int(port)).sendOSC(addr, list(args))

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
        dat = self.ownerComp.op("state")
        if dat is not None:
            dat.clear()
            dat.appendRow(["port", "addr"])

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
        self._set_info("connected", "0")

    def _drop_socket(self, msg):
        self._disconnect()
        self._set_error(msg)
        self._next_connect = time.monotonic() + RECONNECT_S

    # --------------------------------------------------------- legacy re-emit

    def _drop_outputs(self):
        for o in self.ownerComp.ops("oscout_play*"):
            o.destroy()
        self._oscouts = {}
        self._warned_ports = set()

    def _out_for(self, listen_port):
        """oscout DAT for a listen port, mapped through routes / overrides.

        Always the forward side of the route — emitting to the listen port
        would make the tap re-record the replay. Documented cost of Emitosc:
        the re-emit arrives one frame late; new projects should read the
        state table / callbacks instead.
        """
        p = self.ownerComp.par
        dest = int(p.Playport.eval())
        if not dest:
            dest = self.routes.get(listen_port)
        if not dest:
            dest = listen_port
            if listen_port not in self._warned_ports:
                self._warned_ports.add(listen_port)
                print(
                    "VTR: no route for listen port {} — emitting to it directly; "
                    "if osc-tap listens there, set Playport to the forward port".format(listen_port)
                )
        host = str(p.Playhost.eval()).strip() or "127.0.0.1"
        key = (host, dest)
        out = self._oscouts.get(key)
        if out is None or not out.valid:
            out = self.ownerComp.create(oscoutDAT, "oscout_play{}".format(dest))  # noqa: F821
            out.par.address = host
            out.par.port = dest
            out.nodeX = 400
            out.nodeY = -200 * len(self._oscouts)
            self._oscouts[key] = out
        return out
