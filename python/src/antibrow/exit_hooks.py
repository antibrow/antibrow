"""Close live kernels on the way out of the interpreter.

The kernel is its own process-group leader (so one signal can take its whole
tree), which is exactly why nothing collects it when the owner dies. atexit
covers a normal return and an uncaught exception; the signal handlers cover
Ctrl-C and SIGTERM. SIGKILL and a power cut cannot be covered here at all -
`reaper.py` sweeps up after those on the next launch.
"""

from __future__ import annotations

import atexit
import itertools
import signal as _signal
import threading
from typing import Any, Callable, Dict, Optional

_HANDLED_SIGNALS = ("SIGINT", "SIGTERM")


class ExitHooks:
    def __init__(self) -> None:
        self._entries: Dict[int, Callable[[], None]] = {}
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._installed = False
        self._ran = False

    def register(self, close: Callable[[], None]) -> int:
        with self._lock:
            token = next(self._ids)
            self._entries[token] = close
            self._ran = False
            return token

    def unregister(self, token: int) -> None:
        with self._lock:
            self._entries.pop(token, None)

    def run(self) -> None:
        with self._lock:
            if self._ran:
                return
            self._ran = True
            pending = list(self._entries.items())
            self._entries.clear()
        for _token, close in pending:
            # One kernel that is already gone must not strand the rest.
            try:
                close()
            except BaseException:
                pass

    def install(
        self,
        *,
        signal_module: Any = _signal,
        atexit_register: Callable[[Callable[[], None]], Any] = atexit.register,
    ) -> None:
        with self._lock:
            if self._installed:
                return
            self._installed = True

        atexit_register(self.run)

        for name in _HANDLED_SIGNALS:
            number = getattr(signal_module, name, None)
            if number is None:
                continue
            try:
                previous = signal_module.getsignal(number)
            except (ValueError, OSError):
                continue
            try:
                # Only the main thread may install handlers. A worker thread
                # still gets atexit, which is most of the coverage.
                signal_module.signal(number, self._make_handler(number, previous))
            except (ValueError, OSError, RuntimeError):
                continue

    def _make_handler(self, number: int, previous: Any) -> Callable[[int, Any], None]:
        def handler(signum: int, frame: Any) -> None:
            self.run()
            # Chaining, not replacing: swallowing the host application's own
            # handler would be a worse bug than the leak this fixes.
            if callable(previous) and previous not in (
                _signal.SIG_IGN,
                _signal.SIG_DFL,
                _signal.default_int_handler,
            ):
                previous(signum, frame)
                return
            if previous is _signal.default_int_handler:
                raise KeyboardInterrupt
            if previous is _signal.SIG_IGN:
                return
            raise SystemExit(128 + number)

        return handler


_hooks = ExitHooks()


def register_session(close: Callable[[], None]) -> int:
    """Arrange for `close` to run if the interpreter exits with this session open."""
    _hooks.install()
    return _hooks.register(close)


def unregister_session(token: Optional[int]) -> None:
    if token is not None:
        _hooks.unregister(token)
