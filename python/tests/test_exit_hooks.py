"""A kernel must not outlive the interpreter that started it.

Covers every exit Python gets to see; SIGKILL and friends are the reaper's job
(`test_orphan_reaper.py`).
"""

from __future__ import annotations

import pytest

from antibrow.exit_hooks import ExitHooks


class FakeSignal:
    SIGINT = 2
    SIGTERM = 15

    def __init__(self, existing=None):
        self.handlers = dict(existing or {})
        self.installed = {}

    def getsignal(self, num):
        return self.handlers.get(num)

    def signal(self, num, handler):
        previous = self.handlers.get(num)
        self.handlers[num] = handler
        self.installed[num] = handler
        return previous


def test_running_the_hooks_closes_every_live_session():
    hooks = ExitHooks()
    closed = []
    hooks.register(lambda: closed.append("a"))
    hooks.register(lambda: closed.append("b"))

    hooks.run()

    assert closed == ["a", "b"]


def test_an_unregistered_session_is_left_alone():
    hooks = ExitHooks()
    closed = []
    token = hooks.register(lambda: closed.append("a"))
    hooks.register(lambda: closed.append("b"))

    hooks.unregister(token)
    hooks.run()

    assert closed == ["b"]


def test_one_session_that_raises_does_not_strand_the_others():
    hooks = ExitHooks()
    closed = []

    def boom():
        raise RuntimeError("kernel already gone")

    hooks.register(boom)
    hooks.register(lambda: closed.append("b"))

    hooks.run()

    assert closed == ["b"]


def test_hooks_run_only_once_even_if_exit_is_reached_twice():
    """atexit after a signal handler already ran must not double-close."""
    hooks = ExitHooks()
    closed = []
    hooks.register(lambda: closed.append("a"))

    hooks.run()
    hooks.run()

    assert closed == ["a"]


def test_installing_chains_to_a_handler_the_host_app_already_set():
    """A library that swallows the host's SIGTERM handler is worse than a leak."""
    host_saw = []
    fake = FakeSignal({FakeSignal.SIGTERM: lambda num, frame: host_saw.append(num)})
    hooks = ExitHooks()
    registered_atexit = []
    hooks.install(signal_module=fake, atexit_register=registered_atexit.append)

    closed = []
    hooks.register(lambda: closed.append("a"))
    # The host handler decides what happens next - we close kernels and hand over.
    fake.handlers[FakeSignal.SIGTERM](FakeSignal.SIGTERM, None)

    assert closed == ["a"]
    assert host_saw == [FakeSignal.SIGTERM]
    assert len(registered_atexit) == 1


def test_default_sigint_becomes_a_keyboard_interrupt_not_a_silent_exit():
    """Ctrl-C has to keep raising KeyboardInterrupt for the caller's try/except."""
    fake = FakeSignal({FakeSignal.SIGINT: __import__("signal").default_int_handler})
    hooks = ExitHooks()
    hooks.install(signal_module=fake, atexit_register=lambda fn: None)

    closed = []
    hooks.register(lambda: closed.append("a"))
    with pytest.raises(KeyboardInterrupt):
        fake.handlers[FakeSignal.SIGINT](FakeSignal.SIGINT, None)

    assert closed == ["a"]


def test_install_is_idempotent():
    fake = FakeSignal()
    hooks = ExitHooks()
    calls = []
    hooks.install(signal_module=fake, atexit_register=calls.append)
    hooks.install(signal_module=fake, atexit_register=calls.append)

    assert len(calls) == 1


def test_install_survives_a_thread_that_may_not_set_signal_handlers():
    """Only the main thread can install handlers; atexit still has to work."""

    class Refuses(FakeSignal):
        def signal(self, num, handler):
            raise ValueError("signal only works in main thread")

    hooks = ExitHooks()
    calls = []
    hooks.install(signal_module=Refuses(), atexit_register=calls.append)

    closed = []
    hooks.register(lambda: closed.append("a"))
    hooks.run()

    assert calls and closed == ["a"]


def test_sigterm_with_no_host_handler_still_exits():
    """Default SIGTERM disposition is termination; closing kernels must not eat it."""
    fake = FakeSignal({FakeSignal.SIGTERM: __import__("signal").SIG_DFL})
    hooks = ExitHooks()
    hooks.install(signal_module=fake, atexit_register=lambda fn: None)

    closed = []
    hooks.register(lambda: closed.append("a"))
    with pytest.raises(SystemExit):
        fake.handlers[FakeSignal.SIGTERM](FakeSignal.SIGTERM, None)

    assert closed == ["a"]
