"""A kernel download that stops moving must fail as a kernel download failure.

It is deliberately outside the launch budget - a first install is ~1GB, and a
wall-clock cap would just decide how fast your connection has to be. What is
never legitimate is receiving nothing at all for a minute.
"""

from __future__ import annotations

import socket

import pytest

from antibrow import kernel as K
from antibrow.errors import KernelDownloadError


class Stalls:
    """Headers arrive, then the connection goes quiet forever."""

    status = 200
    headers = {"Content-Length": "1048576"}

    def read(self, _size=None):
        raise socket.timeout("timed out")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_a_stalled_download_raises_a_kernel_download_error(tmp_path, monkeypatch):
    monkeypatch.setattr(K.urllib.request, "urlopen", lambda *a, **k: Stalls())

    with pytest.raises(KernelDownloadError) as caught:
        K._download("https://example.com/k.zip", tmp_path / "k.zip")

    assert "stall" in str(caught.value).lower() or "no data" in str(caught.value).lower()


def test_a_stalled_download_leaves_no_half_written_file(tmp_path, monkeypatch):
    monkeypatch.setattr(K.urllib.request, "urlopen", lambda *a, **k: Stalls())
    dest = tmp_path / "k.zip"

    with pytest.raises(KernelDownloadError):
        K._download("https://example.com/k.zip", dest)

    assert not dest.exists()
