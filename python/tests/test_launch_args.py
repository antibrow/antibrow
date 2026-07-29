"""The kernel command line is the protocol - assert it switch by switch."""

from __future__ import annotations

import json

import pytest

from antibrow.errors import ProxyError
from antibrow.launcher import build_launch_args, read_devtools_active_port
from antibrow.proxy import parse_proxy


def args_for(**kwargs):
    options = {
        "fp_config_path": "/tmp/p/fp-config.json",
        "license_token": "PAYLOAD.SIGNATURE",
        "user_data_dir": "/tmp/p/user-data",
        "label": "shopper-01",
        "cdp_port": 45123,
    }
    options.update(kwargs)
    return build_launch_args(**options)


def switch(args, name):
    prefix = "--{0}=".format(name)
    for arg in args:
        if arg.startswith(prefix):
            return arg[len(prefix):]
    return None


def test_required_switches_are_always_present():
    args = args_for()
    assert switch(args, "fp-config") == "/tmp/p/fp-config.json"
    assert switch(args, "fp-license") == "PAYLOAD.SIGNATURE"
    assert switch(args, "user-data-dir") == "/tmp/p/user-data"
    assert switch(args, "fp-address-label") == "shopper-01"
    assert switch(args, "remote-debugging-port") == "45123"
    assert "--remote-allow-origins=*" in args
    assert "--no-first-run" in args
    assert "--no-default-browser-check" in args


def test_language_switch_follows_the_persona():
    assert switch(args_for(language="de-DE"), "lang") == "de-DE"
    assert switch(args_for(), "lang") == "en-US"


def test_linux_gets_the_container_safe_switches_and_windows_does_not():
    linux = args_for(platform="linux")
    for expected in (
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",  # LaunchZygoteHelper aborts before FeatureList is ready
    ):
        assert expected in linux, expected

    windows = args_for(platform="win32")
    assert not [a for a in windows if a in ("--no-sandbox", "--no-zygote")]


def test_headless_moves_the_window_off_screen_instead_of_using_headless_new():
    args = args_for(platform="win32", headless=True)
    assert "--window-position=-10000,-10000" in args
    assert "--window-size=1,1" in args
    # Real headless Chromium has its own detectable fingerprint - never use it.
    assert not [a for a in args if a.startswith("--headless")]

    assert "--window-position=-10000,-10000" not in args_for(platform="win32", headless=False)


def test_headless_on_linux_relies_on_xvfb_not_switches():
    # Documented behaviour: the Linux path adds nothing for headless; run the
    # kernel under Xvfb (see the Dockerfile).
    assert args_for(platform="linux", headless=True) == args_for(platform="linux", headless=False)


def test_extra_args_are_appended_verbatim():
    args = args_for(extra_args=["--mute-audio", "--window-size=1280,800"])
    assert args[-2:] == ["--mute-audio", "--window-size=1280,800"]


# -- proxies --------------------------------------------------------------


def test_http_proxy_credentials_go_inline_for_the_kernel_to_answer():
    proxy = parse_proxy("http://user:p%40ss@gate.example.com:8080")
    assert proxy.username == "user" and proxy.password == "p@ss"
    args = args_for(proxy=proxy)
    assert switch(args, "proxy-server") == "http://user:p%40ss@gate.example.com:8080"
    # Native mode must not load an extension - chrome://extensions is a tell.
    assert not [a for a in args if "load-extension" in a]


def test_socks5_keeps_its_scheme_and_credentials():
    proxy = parse_proxy("socks5://bob:secret@127.0.0.1:1080")
    assert switch(args_for(proxy=proxy), "proxy-server") == "socks5://bob:secret@127.0.0.1:1080"


def test_relay_proxy_is_passed_through_untouched():
    proxy = parse_proxy("relay://apikey:px_123@proxy.antibrow.com")
    args = args_for(proxy=proxy, proxy_auth="extension")  # relay ignores the mode
    assert switch(args, "proxy-server") == "relay://apikey:px_123@proxy.antibrow.com"
    assert not [a for a in args if "load-extension" in a]


def test_proxy_without_credentials_needs_nothing_extra():
    args = args_for(proxy=parse_proxy("http://gate.example.com:8080"))
    assert switch(args, "proxy-server") == "http://gate.example.com:8080"
    assert len([a for a in args if a.startswith("--proxy")]) == 1


def test_extension_mode_strips_credentials_and_writes_a_working_mv3_extension(tmp_path):
    proxy = parse_proxy("http://user:pass@gate.example.com:8080")
    args = args_for(proxy=proxy, proxy_auth="extension", profile_dir=tmp_path)

    assert switch(args, "proxy-server") == "http://gate.example.com:8080"
    ext_dir = tmp_path / "proxy-auth-ext"
    assert switch(args, "load-extension") == str(ext_dir)
    assert switch(args, "disable-extensions-except") == str(ext_dir)

    manifest = json.loads((ext_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["manifest_version"] == 3
    assert "webRequestAuthProvider" in manifest["permissions"]
    background = (ext_dir / "background.js").read_text(encoding="utf-8")
    assert '"user"' in background and '"pass"' in background
    assert "onAuthRequired" in background


def test_extension_mode_refuses_socks5_with_a_useful_message(tmp_path):
    proxy = parse_proxy("socks5://bob:secret@127.0.0.1:1080")
    with pytest.raises(ProxyError, match="native"):
        args_for(proxy=proxy, proxy_auth="extension", profile_dir=tmp_path)


def test_unknown_proxy_auth_mode_is_rejected(tmp_path):
    with pytest.raises(ProxyError):
        args_for(proxy=parse_proxy("http://h:1"), proxy_auth="magic", profile_dir=tmp_path)


# -- DevToolsActivePort ---------------------------------------------------


def test_devtools_active_port_file_is_parsed_when_present(tmp_path):
    (tmp_path / "DevToolsActivePort").write_text("45123\n/devtools/browser/abc\n", encoding="utf-8")
    assert read_devtools_active_port(tmp_path) == "ws://127.0.0.1:45123/devtools/browser/abc"


def test_devtools_active_port_absent_or_garbage_returns_none(tmp_path):
    assert read_devtools_active_port(tmp_path) is None
    (tmp_path / "DevToolsActivePort").write_text("not-a-port", encoding="utf-8")
    assert read_devtools_active_port(tmp_path) is None
