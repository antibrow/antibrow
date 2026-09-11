"""The relay pre-shared key must survive parsing all the way to the kernel.

``?key=`` is what selects the encrypted fp-relay/1 mode; dropping it does not
fail loudly, it downgrades the launch to the legacy plaintext protocol.
"""

import base64
import os

import pytest

from antibrow.proxy import ProxyError, parse_proxy, proxy_args, redact

KEY = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")


def test_key_survives_into_the_proxy_server_switch():
    spec = parse_proxy("relay://alice:s3cret@r.example.com?key={0}".format(KEY))

    assert spec.relay_key == KEY
    args = proxy_args(spec, profile_dir="/tmp")
    assert args == ["--proxy-server=relay://alice:s3cret@r.example.com?key={0}".format(KEY)]


def test_key_survives_with_an_explicit_port():
    spec = parse_proxy("relay://alice:s3cret@r.example.com:8443?key={0}".format(KEY))

    assert spec.to_url() == "relay://alice:s3cret@r.example.com:8443?key={0}".format(KEY)


def test_a_malformed_key_is_refused_rather_than_downgraded():
    with pytest.raises(ProxyError, match="32 bytes"):
        parse_proxy("relay://alice:s3cret@r.example.com?key=tooshort")


def test_key_is_only_meaningful_for_relay():
    spec = parse_proxy("http://user:pass@gate.example.com:8080?key={0}".format(KEY))

    assert spec.relay_key is None
    assert spec.to_url() == "http://user:pass@gate.example.com:8080"


def test_redaction_hides_the_key_as_well_as_the_password():
    url = "relay://alice:s3cret@r.example.com?key={0}".format(KEY)
    spec = parse_proxy(url)

    assert KEY not in str(spec)
    assert "s3cret" not in str(spec)
    assert KEY not in (redact(url) or "")
