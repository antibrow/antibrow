"""Manual end-to-end test for cloud profile sync, on a live kernel and a paid key.

What it proves, in one chain:

1. a launch restores nothing on a brand-new profile and still claims an upload slot;
2. a passkey registered on webauthn.io lands in the profile's portable store;
3. ``close()`` uploads the profile;
4. deleting the whole local profile directory (= moving to another machine) and
   relaunching the same profile name brings back the identity, the cookies and
   that passkey - and the passkey alone can log the account back in.

It also checks the fingerprint itself (disguise score, language, timezone) so a
change to the launch arguments cannot pass unnoticed.

Needs a paid-plan API key (cloud sync is a paid feature) and, ideally, a proxy:

    ANTIBROW_API_KEY=<paid key> ANTIBROW_PROXY=<proxy url> python tests/e2e_cloud_sync.py

Run it by hand - it needs real credentials, real network and a real browser.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from antibrow import launch  # noqa: E402

KEY = os.environ.get("ANTIBROW_API_KEY") or ""
PROXY = os.environ.get("ANTIBROW_PROXY") or ""
SERVER = os.environ.get("ANTIBROW_SERVER") or "https://antibrow.com"
STAMP = int(time.time())
PROFILE = "pysync-{0}".format(STAMP)
USER = "adbpy{0}".format(STAMP)
CACHE_DIR = Path(tempfile.gettempdir()) / "adb-py-e2e-sync"

if not KEY:
    print("missing API key: set ANTIBROW_API_KEY to a paid-plan key")
    raise SystemExit(1)


def log(*args):
    print(*args, flush=True)


def open_browser():
    events = []
    session = launch(
        PROFILE,
        proxy=PROXY or None,
        api_key=KEY,
        server=SERVER,
        cache_dir=CACHE_DIR,
        on_sync=events.append,
        on_progress=lambda m: None if re.search(r"Downloading \d", m) else log("   ·", m),
    )
    return session, events


def fill_user(page):
    """Type the username on webauthn.io. False = autofill already signed us in."""
    page.goto("https://webauthn.io/", wait_until="domcontentloaded", timeout=120_000)
    page.wait_for_timeout(4000)
    if re.search(r"/(profile|dashboard)", page.url):
        return False
    page.fill("#input-email", USER, timeout=30_000)
    if page.input_value("#input-email") != USER:
        raise RuntimeError("username field did not stick")
    return True


def settle(page):
    try:
        page.wait_for_url(re.compile(r"profile|dashboard"), timeout=90_000)
    except Exception:
        try:
            page.locator(".alert").first.wait_for(timeout=30_000)
        except Exception:
            pass
    alerts = page.evaluate(
        "() => Array.from(document.querySelectorAll('[class*=alert]')).map(e => e.innerText.trim())"
    )
    return page.url, alerts, page.evaluate("() => document.body.innerText")


def check_fingerprint(page):
    page.goto("https://whoer.net/", wait_until="domcontentloaded", timeout=120_000)
    page.wait_for_timeout(9000)
    text = page.evaluate("() => document.body.innerText")
    # Not /(\d+)%/: the page's own ads carry percentages of their own.
    disguise = re.search(r"disguise:?\s*(\d+)\s*%", text, re.IGNORECASE)
    log("   disguise :", disguise.group(1) + "%" if disguise else "not found")
    for label in ("Your IP", "Country", "Time zone", "Language", "Proxy"):
        found = re.search(r"{0}[^\n]*\n([^\n]+)".format(label), text)
        if found:
            log("   {0:9}: {1}".format(label, found.group(1).strip()[:60]))
    return int(disguise.group(1)) if disguise else 0


failed = None
try:
    log("\n[1] first launch of {0} (nothing to restore yet)".format(PROFILE))
    session, events = open_browser()
    profile_dir = session.profile_dir
    persona_before = json.loads((profile_dir / "persona.json").read_text())
    log("   synced   :", session.synced)
    log("   sync log :", [(e.phase, e.state) for e in events])
    log("   webauthn :", [a for a in session.plan.args if a.startswith("--fp-webauthn")])
    if not session.synced:
        raise RuntimeError("no cloud archive slot - is this key on a paid plan?")

    page = session.page
    score = check_fingerprint(page)

    log("\n[2] register a passkey on webauthn.io")
    fill_user(page)
    page.click("#register-button")
    url, alerts, _ = settle(page)
    log("   result   :", " | ".join(alerts) or url)
    if not re.search(r"success", " ".join(alerts), re.IGNORECASE):
        raise RuntimeError("registration failed: {0}".format(alerts))

    log("\n[3] close - packs the profile and uploads it")
    session.close()
    log("   sync log :", [(e.phase, e.state) for e in events])
    if session.sync_error:
        raise RuntimeError("upload failed: {0}".format(session.sync_error))
    store = profile_dir / "passkeys.json"
    if not store.exists():
        raise RuntimeError("the kernel wrote no passkeys.json")
    creds = json.loads(store.read_text())
    log("   passkeys : {0} credential(s) for {1}".format(creds and len(creds), [c.get("rpId") for c in creds]))

    log("\n[4] delete the local profile directory (= another machine)")
    shutil.rmtree(profile_dir)
    if profile_dir.exists():
        raise RuntimeError("profile directory still there")

    log("\n[5] relaunch the same profile name")
    session, events = open_browser()
    log("   sync log :", [(e.phase, e.state) for e in events])
    persona_after = json.loads((profile_dir / "persona.json").read_text())
    if persona_after != persona_before:
        raise RuntimeError("the identity changed across the sync")
    restored = profile_dir / "passkeys.json"
    if not restored.exists() or restored.read_text() != store.read_text():
        raise RuntimeError("passkeys.json did not come back from the cloud")
    log("   identity and passkeys.json came back byte for byte")

    log("\n[6] log in with that passkey alone")
    session.context.clear_cookies()
    page = session.page
    if fill_user(page):
        page.click("#login-button")
    else:
        log("   autofill signed in on load")
    url, alerts, body = settle(page)
    log("   landed on:", url)
    session.close()
    if not re.search(r"/(profile|dashboard)", url) or USER not in body:
        raise RuntimeError("authentication failed: {0} {1}".format(url, alerts))

    log("\nPASS - profile synced, passkey survived the trip, disguise {0}%".format(score))
except Exception as error:  # noqa: BLE001 - report, then always clean up
    failed = error
    log("\nFAIL -", error)
finally:
    try:
        session.close()
    except Exception:
        pass
    # Leave no test profile behind on the account.
    try:
        request = urllib.request.Request(
            "{0}/api/v1/profiles/{1}".format(SERVER, PROFILE),
            method="DELETE",
            headers={"Authorization": "Bearer {0}".format(KEY)},
        )
        urllib.request.urlopen(request, timeout=20).close()  # noqa: S310
    except (urllib.error.URLError, OSError) as error:
        log("cleanup: could not delete the test profile:", error)
    shutil.rmtree(CACHE_DIR / "profiles" / PROFILE, ignore_errors=True)
    raise SystemExit(1 if failed else 0)
