"""New personas take their languages from the first exit country, then keep them."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from antibrow import browser as B
from antibrow import license as L
from antibrow.country_languages import (
    CHROME_LOCALES,
    COUNTRY_ACCEPT_LANGUAGE,
    chrome_locale,
    languages_for_country,
)
from antibrow.geoip import ProxyGeo
from antibrow.persona import Persona, generate_persona, settle_persona_languages

JS_GEO = Path(__file__).resolve().parents[2] / "js" / "src" / "geo.ts"


def _on_disk(directory: Path) -> dict:
    return json.loads((directory / "persona.json").read_text(encoding="utf-8"))


def test_the_table_matches_the_js_sdk():
    if not JS_GEO.exists():
        pytest.skip("JS SDK source not present")
    block = JS_GEO.read_text(encoding="utf-8").split("const COUNTRY_LOCALE")[1]
    js = dict(re.findall(r"^\s+([A-Z]{2}): \['[^']+', '([^']+)'\],", block, re.M))
    assert js == COUNTRY_ACCEPT_LANGUAGE
    packs = re.search(r"const CHROME_LOCALES = new Set\(\s*\(([^)]*)\)", JS_GEO.read_text(encoding="utf-8")).group(1)
    assert set(re.findall(r"[\w-]+", packs.replace("'", " ").replace("+", " "))) - {"split"} == set(CHROME_LOCALES)


def test_every_country_leads_with_a_shipped_locale_pack():
    # On macOS the kernel aborts at startup for any other first tag.
    for code in COUNTRY_ACCEPT_LANGUAGE:
        assert languages_for_country(code)[0] in CHROME_LOCALES, code
    assert languages_for_country("SG") == ["en-US", "en", "zh"]
    assert languages_for_country("DE") == ["de", "en"]
    assert languages_for_country("HK") == ["zh-TW", "zh", "en"]
    assert languages_for_country("MX") == ["es-419", "es", "en"]
    assert chrome_locale("en-AU") == "en-GB"


def test_languages_follow_the_accept_language_order():
    assert languages_for_country("CN") == ["zh-CN", "zh", "en"]
    assert languages_for_country("us") == ["en-US", "en"]
    assert languages_for_country("ZZ") is None


def test_a_new_persona_settles_once_and_persists(tmp_path):
    fresh = generate_persona(152, "152")
    assert fresh.languages_pending
    raw = dict(fresh.to_dict(), kernelVersion="as-written")
    assert raw["languagesPending"] is True
    (tmp_path / "persona.json").write_text(json.dumps(raw), encoding="utf-8")

    settled = settle_persona_languages(tmp_path, fresh, "CN")
    assert settled.languages == ["zh-CN", "zh", "en"]
    assert not settled.languages_pending
    on_disk = _on_disk(tmp_path)
    assert on_disk["languages"] == ["zh-CN", "zh", "en"]
    assert "languagesPending" not in on_disk
    assert on_disk["kernelVersion"] == "as-written"
    assert Persona.from_dict(on_disk).languages_pending is False


def test_a_profile_from_before_the_flag_is_left_alone(tmp_path):
    legacy = generate_persona(152, "152").to_dict()
    del legacy["languagesPending"]
    persona = Persona.from_dict(legacy)
    assert settle_persona_languages(tmp_path, persona, "CN") is persona
    assert not (tmp_path / "persona.json").exists()


def test_waits_for_a_country_and_settles_on_the_default_for_an_unlisted_one(tmp_path):
    fresh = generate_persona(152, "152")
    assert settle_persona_languages(tmp_path, fresh, "") is fresh
    settled = settle_persona_languages(tmp_path, fresh, "ZZ")
    assert settled.languages == ["en-US", "en"]
    assert not settled.languages_pending


@pytest.fixture
def fake_launch(tmp_path, monkeypatch):
    exe = tmp_path / "chrome"
    exe.write_bytes(b"fake")
    monkeypatch.setattr(B._kernel, "ensure_kernel", lambda *a, **k: exe)
    monkeypatch.setattr(B._kernel, "refresh_kernel_versions", lambda *a, **k: False)
    info = L.LicenseInfo(token="PAYLOAD.SIG", exp=2**31, mi=5, sync=False)
    monkeypatch.setattr(B, "get_license_token", lambda *a, **k: info)


def _exit(monkeypatch, name, country_code, timezone):
    geo = ProxyGeo(ip="203.0.113.7", country="", timezone=timezone, country_code=country_code)
    monkeypatch.setattr(B, name, lambda *a, **k: geo)


def _languages(plan) -> list:
    return json.loads((plan.profile_dir / "fp-config.json").read_text(encoding="utf-8"))["navigator"]["languages"]


def test_the_first_exit_country_sticks_when_the_proxy_changes(tmp_path, fake_launch, monkeypatch):
    proxy = "http://gate.example.com:8080"
    _exit(monkeypatch, "lookup_proxy_geo", "CN", "Asia/Shanghai")
    assert _languages(B.prepare_launch(cache_dir=tmp_path, profile="p1", proxy=proxy)) == ["zh-CN", "zh", "en"]
    _exit(monkeypatch, "lookup_proxy_geo", "US", "America/Chicago")
    second = B.prepare_launch(cache_dir=tmp_path, profile="p1", proxy=proxy)
    assert _languages(second) == ["zh-CN", "zh", "en"]
    assert "--lang=zh-CN" in second.args


def test_a_failed_lookup_leaves_it_pending_for_the_next_launch(tmp_path, fake_launch, monkeypatch):
    monkeypatch.setattr(B, "lookup_direct_geo", lambda *a, **k: None)
    assert _languages(B.prepare_launch(cache_dir=tmp_path, profile="p1")) == ["en-US", "en"]
    _exit(monkeypatch, "lookup_direct_geo", "DE", "Europe/Berlin")
    assert _languages(B.prepare_launch(cache_dir=tmp_path, profile="p1")) == ["de", "en"]
