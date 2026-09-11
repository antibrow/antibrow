import { AntiDetectBrowser } from 'anti-detect-browser'
import type { LaunchResult } from 'anti-detect-browser'

export type AntibrowSessionOptions = {
  /** AntiBrow API key. Defaults to `process.env.ANTI_DETECT_BROWSER_KEY`. */
  key?: string
  /**
   * Profile name. The same name always gets the same fingerprint, cookies and
   * storage, which is the point: an agent that signed in yesterday is still
   * signed in today. Unlimited and free locally.
   */
  profile?: string
  /** Per-profile proxy URL (`http`, `https` or `socks5`, credentials in the URL). */
  proxy?: string
  /** Discard the profile when the session closes. */
  temporary?: boolean
  /** Hide the window. */
  headless?: boolean
  /** Characters of page text a read may return, so one page cannot fill the context window. */
  readLimit?: number
}

/**
 * One browser, one page, started on first use and shared by every tool in the
 * session - which is what makes the tools composable: a read reads whatever the
 * last navigation opened.
 */
export class AntibrowSession {
  private launched?: Promise<LaunchResult>
  readonly readLimit: number

  constructor(private readonly options: AntibrowSessionOptions = {}) {
    this.readLimit = options.readLimit ?? 4000
  }

  private launch(): Promise<LaunchResult> {
    if (!this.launched) {
      const key = this.options.key ?? process.env.ANTI_DETECT_BROWSER_KEY
      if (!key) {
        throw new Error(
          'AntiBrow needs an API key: pass `key` or set ANTI_DETECT_BROWSER_KEY.',
        )
      }
      const ab = new AntiDetectBrowser({ key, temporary: this.options.temporary })
      this.launched = ab.launch({
        profile: this.options.profile ?? 'agent',
        label: this.options.profile ?? 'agent',
        proxy: this.options.proxy,
        headless: this.options.headless,
        focusWindow: false,
      } as never)
    }
    return this.launched
  }

  async page() {
    const { page } = await this.launch()
    return page
  }

  /** Close the browser. Safe to call when nothing was ever launched. */
  async close(): Promise<void> {
    if (!this.launched) return
    const { browser } = await this.launched
    this.launched = undefined
    await browser.close()
  }
}
