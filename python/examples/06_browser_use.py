"""browser-use: give the agent a browser the web can't tell from a person's.

browser-use attaches over CDP, so antibrow just hands it an endpoint. Your agent
keeps its cookies, its fingerprint and its proxy exit across runs, because the
profile is on disk.

    pip install antibrow browser-use
    export OPENAI_API_KEY=...  ANTIBROW_API_KEY=...
    python examples/06_browser_use.py

Note: browser-use has moved its connection API around across releases. Both
current and older spellings are handled below - the CDP URL is the stable part.
"""

import asyncio
import os

from antibrow import launch_async


def make_browser_session(cdp_url: str):
    """Build whatever browser object this browser-use version expects."""
    try:  # browser-use >= 0.7
        from browser_use import Browser

        return "browser", Browser(cdp_url=cdp_url)
    except ImportError:
        pass
    try:  # browser-use 0.2 - 0.6
        from browser_use.browser.session import BrowserSession

        return "browser_session", BrowserSession(cdp_url=cdp_url)
    except ImportError as exc:  # pragma: no cover - depends on the installed version
        raise SystemExit(
            "Could not find a browser-use connection class. "
            "Install browser-use (`pip install browser-use`) or pass "
            "cdp_url={0!r} to whatever your version expects.".format(cdp_url)
        ) from exc


async def main() -> None:
    from browser_use import Agent
    from browser_use.llm import ChatOpenAI

    session = await launch_async(
        profile="agent-01",
        proxy=os.environ.get("ANTIBROW_PROXY"),   # optional; timezone follows it
        headless=False,
    )
    print("kernel:", session.kernel_version, "| cdp:", session.cdp_url)
    print("identity:", session.persona.ua)

    kwarg, browser_obj = make_browser_session(session.cdp_url)
    agent = Agent(
        task="Go to news.ycombinator.com and list the titles of the top 5 stories.",
        llm=ChatOpenAI(model="gpt-4.1-mini"),
        **{kwarg: browser_obj},
    )

    try:
        result = await agent.run(max_steps=15)
        print(result)
    finally:
        await session.close()


if __name__ == "__main__":
    asyncio.run(main())
