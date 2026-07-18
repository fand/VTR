"""VTRExt — extension for vtr.tox. TouchDesigner-only code.

Everything testable lives in vtr_core (pure Python); this file is the thin TD
layer: parameters, the clock/rec control OSC, and the per-frame playback cook.
Spec: docs/tasks/td/spec.md.
"""

try:  # dev checkout: td/src on sys.path
    from vtr_core import resolver as _resolver
    from vtr_core import session as _session
except ImportError:  # shipped tox: core modules are sibling Text DATs
    _session = mod("core_session")  # noqa: F821
    _resolver = mod("core_resolver")  # noqa: F821


class VTRExt:
    def __init__(self, ownerComp):
        self.ownerComp = ownerComp
        self.session = None
        self.resolver = None
        self.load_error = ""
        self._last_clock = float("-inf")  # absTime of the last /clock
        self._pos = 0.0  # internal transport position (Locktotimeline off)
        self._last_abs = None
        self._oscouts = {}  # (host, port) -> oscout DAT
        self._warned_ports = set()
        self.Reload()

    # ------------------------------------------------------------------ util

    def _timeline(self):
        """(t, rate) of the root timeline; rate is 0 while paused."""
        t = op("/").time  # noqa: F821
        rate = float(t.rate) if t.play else 0.0
        return float(t.seconds), rate

    def _ctrl(self):
        return self.ownerComp.op("oscout_ctrl")

    def _is_trigger(self, addr):
        pats = str(self.ownerComp.par.Triggerpatterns.eval()).split()
        return any(tdu.match(p, [addr]) for p in pats)  # noqa: F821

    # ------------------------------------------------------------- callbacks

    def OnFrame(self):
        """Called every frame (Execute DAT, frameStart)."""
        self._clock_tick()
        self._play_tick()

    def OnParChange(self, par):
        """Called from the Parameter Execute DAT."""
        name = par.name
        if name == "Record":
            t, rate = self._timeline()
            if par.eval():
                self._ctrl().sendOSC("/rec/start", [t, rate])
            else:
                self._ctrl().sendOSC("/rec/stop", [])
        elif name in ("File", "Triggerpatterns"):
            self.Reload()  # trigger classification is baked into the resolver
        elif name in ("Playhost", "Playport"):
            self._drop_outputs()
        elif name in ("Locktotimeline", "Play"):
            if self.resolver:
                self.resolver.reset()
            self._last_abs = None

    def OnPulse(self, par):
        if par.name == "Rewind":
            self._pos = 0.0
            if self.resolver:
                self.resolver.reset()

    # ------------------------------------------------------------------- rec

    def _clock_tick(self):
        p = self.ownerComp.par
        if not p.Clock.eval():
            return
        now = absTime.seconds  # noqa: F821
        hz = max(0.1, float(p.Clockrate.eval()))
        if now - self._last_clock < 1.0 / hz:
            return
        self._last_clock = now
        t, rate = self._timeline()
        self._ctrl().sendOSC("/clock", [t, rate])

    # ------------------------------------------------------------------ play

    def Reload(self):
        """(Re)load the session file named by the File parameter."""
        self.session = None
        self.resolver = None
        self.load_error = ""
        self._drop_outputs()
        path = self.ownerComp.par.File.eval()
        if not path:
            return
        try:
            self.session = _session.load(path)
        except Exception as e:  # surface, never break the network
            self.load_error = "{}: {}".format(path, e)
            print("VTR: load failed —", self.load_error)
            return
        if self.session.skipped:
            print("VTR: skipped {} malformed lines in {}".format(self.session.skipped, path))
        self.resolver = _resolver.Resolver(self.session, trigger_matcher=self._is_trigger)

    def _play_tick(self):
        if not self.resolver:
            return
        p = self.ownerComp.par
        if p.Locktotimeline.eval():
            pos = float(op("/").time.seconds) - float(p.Offset.eval())  # noqa: F821
        else:
            now = absTime.seconds  # noqa: F821
            if not p.Play.eval():
                self._last_abs = None
                return
            if self._last_abs is not None:
                self._pos += now - self._last_abs
            self._last_abs = now
            pos = self._pos
        for port, addr, args in self.resolver.step(pos):
            self._out_for(port).sendOSC(addr, args)

    def _drop_outputs(self):
        for o in self.ownerComp.ops("oscout_play*"):
            o.destroy()
        self._oscouts = {}
        self._warned_ports = set()

    def _out_for(self, listen_port):
        """oscout DAT for a listen port, mapped through routes / overrides.

        Always the forward side of the route — emitting to the listen port
        would make the tap re-record the replay.
        """
        p = self.ownerComp.par
        dest = int(p.Playport.eval())
        if not dest:
            dest = self.session.routes.get(listen_port)
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
