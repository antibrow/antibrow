"""Proxies, and making the fingerprint agree with the exit node.

A US residential exit paired with a Europe/Berlin clock is one of the cheapest
ways to get flagged. With geoip=True (the default) antibrow resolves the exit IP
*through the proxy* before launch and writes that timezone - plus the public IP
for WebRTC - into the fingerprint.

    ANTIBROW_PROXY="http://user:pass@gate.example.com:8080" python examples/03_proxy_geoip.py

Supported: http://, https://, socks5:// (credentials are answered inside the
kernel, no extension), and AntiBrow's managed relay:// proxies.
"""

import os

from antibrow import launch, lookup_proxy_geo

PROXY = os.environ.get("ANTIBROW_PROXY", "http://user:pass@gate.example.com:8080")


def main() -> None:
    # Optional: check the exit before spending a browser launch on it.
    geo = lookup_proxy_geo(PROXY)
    if geo is None:
        print("proxy unreachable or blocked - launching anyway, timezone will fall back")
    else:
        print("exit ip:", geo.ip, "|", geo.country, "|", geo.timezone)

    with launch(
        profile="demo-proxy",
        proxy=PROXY,        # or {"server": "http://gate:8080", "username": "u", "password": "p"}
        geoip=True,         # default: timezone + WebRTC follow the exit node
        # timezone="Europe/Berlin",   # force one instead, if you must
    ) as browser:
        print("fingerprint timezone:", browser.timezone)
        print("fingerprint public ip:", browser.public_ip)

        page = browser.new_page()
        page.goto("https://ipinfo.io/json", wait_until="domcontentloaded")
        print("page sees:", page.inner_text("body")[:300])

        page.goto("https://whoer.net")
        page.wait_for_timeout(6000)
        page.screenshot(path="whoer.png", full_page=True)
        print("saved whoer.png - check that IP, timezone and language line up")


if __name__ == "__main__":
    main()
