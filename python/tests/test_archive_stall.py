"""A stalled archive transfer must stay a sync failure, not a failed launch.

`_restore_archive` only catches `ProfileCacheError`; a bare socket timeout
escaping from the read would take the whole launch down with it, which is the
opposite of the "cloud sync is best-effort" rule everything else follows.
"""

from __future__ import annotations

import socket

import pytest

from antibrow import profile_cache as PC
from antibrow.errors import ProfileCacheError


class Stalls:
    status = 200
    headers = {}

    def read(self, _size=None):
        raise socket.timeout("timed out")

    def getheader(self, _name, _default=None):
        return _default

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_a_stalled_archive_download_is_a_profile_cache_error(tmp_path, monkeypatch):
    monkeypatch.setattr(PC.urllib.request, "urlopen", lambda *a, **k: Stalls())

    with pytest.raises(ProfileCacheError):
        PC.download_profile_cache("https://example.com/a.zip", tmp_path)


def test_a_stalled_archive_upload_is_a_profile_cache_error(tmp_path, monkeypatch):
    """An upload stalls while sending, so urlopen itself is what times out."""
    (tmp_path / "user-data").mkdir(parents=True, exist_ok=True)
    (tmp_path / "persona.json").write_text("{}")

    def stall(*_a, **_k):
        raise socket.timeout("timed out")

    monkeypatch.setattr(PC.urllib.request, "urlopen", stall)

    with pytest.raises(ProfileCacheError):
        PC.upload_profile_cache(tmp_path, "https://example.com/a.zip")
