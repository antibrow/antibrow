import type { BrowserContext, Page } from 'playwright-core'
import {
  uploadProfileState,
  downloadProfileState,
  type ProfileState,
  type ProfileStateCookie,
  type ProfileStateOrigin,
} from './api'

/**
 * Profile-state sync: capture cookies, localStorage and open tabs from a live
 * context, upload that snapshot, and restore it into a fresh context. Shared by
 * every client so the capture/restore behaviour is identical everywhere.
 */

export interface CapturedState {
  cookies: ProfileStateCookie[]
  origins: ProfileStateOrigin[]
  tabs: string[]
}

// `restoreOrigins` runs inside the page, not in Node. See the note in
// tsconfig.json for why the DOM lib is not enabled program-wide.
declare const location: { origin: string }
declare const localStorage: { length: number; setItem(key: string, value: string): void }

const isRealUrl = (u: string): boolean =>
  !!u && u !== 'about:blank' && !u.startsWith('chrome') && !u.startsWith('about')

/**
 * Seed localStorage for the current origin from a saved snapshot. Runs inside
 * the page before its own scripts, so it must stay self-contained: Playwright
 * serialises it with Function.prototype.toString.
 *
 * Existing values always win - a page that already has state is left untouched.
 */
function restoreOrigins(origins: ProfileStateOrigin[]): void {
  for (const entry of origins) {
    if (entry.origin !== location.origin) continue
    if (localStorage.length > 0) return
    for (const item of entry.localStorage) {
      try {
        localStorage.setItem(item.name, item.value)
      } catch {
        // Quota or a blocked origin: skip the item, keep going.
      }
    }
    return
  }
}

/** Read cookies + localStorage origins + open tab URLs from a live context. */
export async function captureState(context: BrowserContext): Promise<CapturedState> {
  const storage = await context.storageState()
  const tabs = context.pages().map((p) => p.url()).filter(isRealUrl)
  return { cookies: storage.cookies, origins: storage.origins, tabs }
}

/** Capture the live context state and upload it. Throws on failure. */
export async function captureAndUploadState(
  context: BrowserContext,
  opts: { key: string; server?: string; name: string },
): Promise<void> {
  const snap = await captureState(context)
  await uploadProfileState({ key: opts.key, server: opts.server, name: opts.name, ...snap })
}

/**
 * Apply a saved snapshot to a fresh context. localStorage is injected by an init
 * script that runs before page scripts and never overwrites existing values.
 */
export async function restoreState(
  context: BrowserContext,
  page: Page,
  saved: ProfileState,
  opts: { openTabs?: boolean } = {},
): Promise<void> {
  if (saved.cookies?.length) await context.addCookies(saved.cookies as Parameters<BrowserContext['addCookies']>[0]).catch(() => {})
  if (saved.origins?.length) {
    // Passed as a serialised argument rather than spliced into script source:
    // the saved snapshot is attacker-influenced (any visited site can write to
    // its own localStorage), so it must never be parsed as code.
    await context.addInitScript(restoreOrigins, saved.origins).catch(() => {})
  }
  if (opts.openTabs && saved.tabs?.length) {
    await page.goto(saved.tabs[0]).catch(() => {})
    for (let i = 1; i < saved.tabs.length; i++) {
      const tab = await context.newPage()
      await tab.goto(saved.tabs[i]).catch(() => {})
    }
  }
}

/** Download the saved snapshot and restore it. Never throws. */
export async function restoreSavedState(
  context: BrowserContext,
  page: Page,
  opts: { key: string; server?: string; name: string; openTabs?: boolean },
): Promise<void> {
  const saved = await downloadProfileState({ key: opts.key, server: opts.server, name: opts.name }).catch(() => null)
  if (saved) await restoreState(context, page, saved, { openTabs: opts.openTabs })
}
