"""Coming from Puppeteer (or the Node SDK)? Here is the mapping.

antibrow exposes a plain CDP endpoint, so anything that speaks CDP can drive it,
in any language. This file shows the Python translation of the Puppeteer idioms
people ask about most, and prints the endpoint you would hand to Node.

    python examples/05_puppeteer_style.py

Puppeteer (Node), attaching to the very same browser:

    const puppeteer = require('puppeteer-core')
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:PORT' })
    const [page] = await browser.pages()
    await page.goto('https://example.com')

Node SDK equivalent of this whole file (npm: anti-detect-browser):

    const ab = new AntiDetectBrowser({ key: process.env.ANTI_DETECT_BROWSER_KEY })
    const { page, browser } = await ab.launch({ profile: 'shopper-01' })
"""

from antibrow import launch


def main() -> None:
    browser = launch(profile="demo-puppeteer")

    # Hand this to puppeteer.connect({ browserURL }) or any CDP client.
    print("CDP http endpoint:", browser.cdp_url)
    print("CDP ws endpoint:  ", browser.cdp_endpoint)

    # puppeteer: const page = await browser.newPage()
    page = browser.new_page()

    # puppeteer: await page.goto(url, { waitUntil: 'networkidle2' })
    page.goto("https://example.com", wait_until="networkidle")

    # puppeteer: await page.$eval('h1', el => el.textContent)
    print("h1:", page.locator("h1").inner_text())

    # puppeteer: await page.evaluate(() => navigator.userAgent)
    print("ua:", page.evaluate("() => navigator.userAgent"))

    # puppeteer: await page.type('#q', 'hello') / await page.click('#go')
    #   playwright locators are the modern equivalent:
    #   page.get_by_placeholder("Search").fill("hello")
    #   page.get_by_role("button", name="Go").click()

    # puppeteer: await page.setViewport({ width, height })
    page.set_viewport_size({"width": 1280, "height": 800})

    # puppeteer: await page.screenshot({ path, fullPage: true })
    page.screenshot(path="example.png", full_page=True)

    # puppeteer: await page.waitForSelector('h1')
    page.wait_for_selector("h1")

    # puppeteer: browser.close()  -> also stops the kernel process here
    browser.close()


if __name__ == "__main__":
    main()
