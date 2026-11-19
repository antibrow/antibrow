import pytest

from antibrow import license as lic
from antibrow.errors import LicenseError


def test_no_key_message_names_the_custom_server(monkeypatch):
    monkeypatch.delenv("ANTIBROW_API_KEY", raising=False)
    monkeypatch.setattr(lic, "resolve_api_key", lambda _key=None: None)
    with pytest.raises(LicenseError) as exc:
        lic.get_license_token(server="https://api.acme.com/", use_cache=False)
    assert "https://api.acme.com" in str(exc.value)
    assert "antibrow.com" not in str(exc.value)


def test_no_key_message_on_the_default_server(monkeypatch):
    monkeypatch.setattr(lic, "resolve_api_key", lambda _key=None: None)
    monkeypatch.delenv("ANTI_DETECT_BROWSER_SERVER", raising=False)
    monkeypatch.delenv("ANTIBROW_SERVER", raising=False)
    with pytest.raises(LicenseError) as exc:
        lic.get_license_token(server="https://antibrow.com", use_cache=False)
    assert "free key" in str(exc.value)
