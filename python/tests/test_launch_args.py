"""The kernel command line is the protocol - assert it switch by switch."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from antibrow.errors import ProxyError
from antibrow.launcher import build_launch_args, is_stray_locale_tab_url, read_devtools_active_port
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


@pytest.mark.parametrize("platform", ["win32", "linux", "darwin"])
def test_device_bound_sessions_stay_off(platform):
    # A device-bound session's private key lives in the OS keystore and cannot
    # be exported, so a profile carrying one is refused on the next machine:
    # Gmail comes up signed out while GitHub, which does not use DBSC, does not.
    assert "--disable-features=DeviceBoundSessions" in args_for(platform=platform)


@pytest.mark.parametrize("platform", ["win32", "linux", "darwin"])
def test_previous_tabs_are_restored_by_default(platform):
    # The default startup is the new tab page and only a crashed exit offers
    # restore, so left alone whether the tabs return depends on how the previous
    # session happened to die.
    args = args_for(platform=platform)
    assert "--restore-last-session" in args
    assert "--hide-crash-restore-bubble" in args


def test_restore_can_be_turned_off():
    args = args_for(restore_tabs=False)
    assert "--restore-last-session" not in args
    assert "--hide-crash-restore-bubble" not in args


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


# -- macOS: no container-only sandbox switches -----------------------------


def test_linux_keeps_the_container_switches():
    args = args_for(platform="linux")
    assert "--no-sandbox" in args
    assert "--no-zygote" in args


def test_darwin_does_not_disable_the_sandbox():
    args = args_for(platform="darwin")
    assert "--no-sandbox" not in args
    assert "--disable-setuid-sandbox" not in args
    assert "--disable-dev-shm-usage" not in args
    assert "--no-zygote" not in args
    # The switches that are not container-specific stay put.
    assert switch(args, "remote-debugging-port") == "45123"


def test_windows_still_has_no_container_switches():
    assert "--no-sandbox" not in args_for(platform="win32")


def test_linux_only_switches_are_exactly_the_seven_container_switches():
    # Derived from the diff between linux and darwin argv rather than filtered
    # against our own expected list, so an eighth switch sneaking into the
    # linux block would fail this test instead of being silently ignored.
    linux_only = set(args_for(platform="linux")) - set(args_for(platform="darwin"))
    assert linux_only == {
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-crash-reporter",
        "--no-zygote",
    }


# -- macOS: -AppleLanguages steers ICU (Intl.*), --lang/LANG do not ----------


def test_darwin_gets_apple_languages_derived_from_the_persona_language():
    args = args_for(platform="darwin", language="en-US")
    assert "-AppleLanguages" in args
    idx = args.index("-AppleLanguages")
    assert args[idx + 1] == "(en-US)"

    de_args = args_for(platform="darwin", language="de-DE")
    assert de_args[de_args.index("-AppleLanguages") + 1] == "(de-DE)"


def test_apple_languages_is_absent_on_win32_and_linux():
    assert "-AppleLanguages" not in args_for(platform="win32")
    assert "-AppleLanguages" not in args_for(platform="linux")


# -- the stray tab that pair costs us ---------------------------------------
#
# "(en-US)" has no leading dash, so Chromium's own parser takes it for a
# positional argument and opens it as a URL. Confirmed against a real Chromium
# build: the tab lands on "http://(en-us)/", lowercased by URL fixup.


def test_stray_locale_tab_url_matches_what_chromium_opens():
    assert is_stray_locale_tab_url("http://(en-us)/", "en-US")
    assert is_stray_locale_tab_url("http://(de-de)/", "de-DE")
    assert is_stray_locale_tab_url("(en-US)", "en-US")
    assert is_stray_locale_tab_url("http%3A%2F%2F(en-us)%2F", "en-US")


def test_stray_locale_tab_url_leaves_real_pages_alone():
    for url in [
        "about:blank",
        "https://whoer.net/",
        "https://example.com/?q=(en-us)",
        "http://en-us/",
        "chrome://newtab/",
    ]:
        assert not is_stray_locale_tab_url(url, "en-US")


# The portable passkey store lives at the profile root, not under user-data:
# that is what lets an export or a cloud sync carry passkeys to another machine.


def test_passkey_store_points_at_the_profile_root():
    # Built with pathlib, so the separator is the host's - compare the same way
    # rather than against a POSIX literal, which fails on Windows runners.
    args = args_for(profile_dir="/tmp/p")
    assert switch(args, "fp-webauthn-store") == str(Path("/tmp/p") / "passkeys.json")


def test_passkey_store_falls_back_to_the_user_data_dir_when_no_profile_dir():
    expected = str(Path("/tmp/p/user-data") / "passkeys.json")
    assert switch(args_for(), "fp-webauthn-store") == expected


def test_capturing_passkeys_is_the_default_and_opt_out_asks_the_user_instead():
    assert "--fp-webauthn-create=choose" not in args_for(profile_dir="/tmp/p")
    assert "--fp-webauthn-create=choose" not in args_for(profile_dir="/tmp/p", webauthn_capture=True)
    assert "--fp-webauthn-create=choose" in args_for(profile_dir="/tmp/p", webauthn_capture=False)


# --no-startup-window would stop the locale argument from ever being opened as a
# URL, but it also defers session restore: Chromium then restores the profile's
# previous tabs into a window of its own, next to the one the SDK creates over
# CDP, so an existing profile opens with two windows. Verified on a real profile.


def test_the_startup_window_is_never_suppressed():
    for platform in ("win32", "linux", "darwin"):
        assert "--no-startup-window" not in args_for(platform=platform), platform


# -- feature-switch merging ------------------------------------------------
#
# Chromium keeps only the LAST occurrence of --enable-features /
# --disable-features. A caller passing its own would silently drop ours, and
# losing --disable-features=DeviceBoundSessions re-arms the cross-machine
# sign-out this SDK exists to prevent - with no error anywhere.


def test_caller_supplied_disable_features_does_not_drop_ours():
    args = args_for(extra_args=["--disable-features=Translate"])
    switches = [a for a in args if a.startswith("--disable-features=")]

    assert len(switches) == 1
    values = switches[0].split("=", 1)[1].split(",")
    assert "DeviceBoundSessions" in values
    assert "Translate" in values


def test_enable_features_is_merged_the_same_way():
    args = args_for(extra_args=["--enable-features=A", "--enable-features=B"])
    switches = [a for a in args if a.startswith("--enable-features=")]

    assert len(switches) == 1
    assert switches[0].split("=", 1)[1].split(",") == ["A", "B"]


def test_repeated_values_are_not_duplicated():
    args = args_for(extra_args=["--disable-features=DeviceBoundSessions,Translate"])
    values = [a for a in args if a.startswith("--disable-features=")][0].split("=", 1)[1].split(",")

    assert values.count("DeviceBoundSessions") == 1


def test_merging_leaves_every_other_switch_untouched():
    extra = ["--mute-audio", "--disable-features=Translate", "--window-size=800,600"]
    args = args_for(extra_args=extra)

    assert "--mute-audio" in args
    assert "--window-size=800,600" in args
    # The merged switch keeps the position of the first occurrence, which is
    # ours, so caller args stay in their original relative order.
    assert args.index("--mute-audio") < args.index("--window-size=800,600")
