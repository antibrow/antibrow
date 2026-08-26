"""One budget for the whole launch.

Every network step already had its own socket timeout, but nothing added them
up: a launch could sit through a slow license call, a slow archive probe and a
wedged proxy in series and blow far past the `timeout` the caller passed - which
only ever covered spawning the kernel and connecting to CDP.

Kernel downloads and archive transfers deliberately stay *out* of this budget:
a first install is legitimately hundreds of megabytes. Those are bounded by a
stall timeout instead - no bytes for N seconds - so slow-but-moving survives and
actually-dead does not.
"""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from typing import Callable, Iterator, Optional

from .errors import LaunchTimeout

INFINITY = float("inf")


class Deadline:
    def __init__(
        self,
        total: Optional[float],
        *,
        clock: Callable[[], float] = time.monotonic,
        step: Optional[str] = None,
    ) -> None:
        self._total = total if total and total > 0 else None
        self._clock = clock
        self._started = clock()
        self._step = step

    @property
    def total(self) -> Optional[float]:
        return self._total

    @property
    def step(self) -> Optional[str]:
        return self._step

    def remaining(self) -> float:
        if self._total is None:
            return INFINITY
        return self._total - (self._clock() - self._started)

    @contextmanager
    def paused(self) -> Iterator[None]:
        """Run a stretch that the budget must not be charged for.

        Wraps the two steps that move real bytes - installing a kernel,
        restoring a cloud archive. Both are bounded by a stall timeout of their
        own; charging them to a launch budget would just cap how big a download
        the SDK can survive.
        """
        entered = self._clock()
        try:
            yield
        finally:
            self._started += self._clock() - entered

    def check(self, step: Optional[str] = None) -> None:
        """Note which step is starting, and stop if the budget is already spent."""
        if step is not None:
            self._step = step
        if self.remaining() <= 0:
            raise self._expired()

    def budget(self, default: float) -> float:
        """The socket timeout for one step: its own, or what is left, whichever is less."""
        left = self.remaining()
        if left <= 0:
            raise self._expired()
        return default if left == INFINITY else min(default, left)

    @contextmanager
    def active(self) -> Iterator["Deadline"]:
        """Publish this budget so every SDK HTTP call shrinks to fit it.

        Thread-local, and `launch_async` prepares in a worker thread, so it is
        entered inside that thread rather than around the executor call.
        """
        previous = getattr(_current, "deadline", None)
        _current.deadline = self
        try:
            yield self
        finally:
            _current.deadline = previous

    def _expired(self) -> LaunchTimeout:
        where = " while {0}".format(self._step) if self._step else ""
        return LaunchTimeout(
            "Launch timed out after {0:g}s{1}".format(self._total, where), step=self._step
        )


_current = threading.local()


def current() -> Optional[Deadline]:
    return getattr(_current, "deadline", None)


def remaining_budget(default: float) -> Optional[float]:
    """Socket timeout for one call under the active budget.

    None means the budget is already spent - the caller must not fall back to
    its own timeout, and must not pass 0 to a socket either (that is a
    non-blocking socket, not an instant failure).
    """
    deadline = current()
    if deadline is None:
        return default
    left = deadline.remaining()
    if left <= 0:
        return None
    return default if left == INFINITY else min(default, left)
