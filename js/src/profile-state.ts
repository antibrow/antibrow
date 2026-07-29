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

const isRealUrl = (u: string): boolean =>
  !!u && u !== 'about:blank' && !u.startsWith('chrome') && !u.startsWith('about')

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
    const originsJson = JSON.stringify(saved.origins)
    await context.addInitScript(
      `(function(){var d=${originsJson};var o=location.origin;for(var i=0;i<d.length;i++){if(d[i].origin!==o)continue;if(localStorage.length>0)return;var ls=d[i].localStorage;for(var j=0;j<ls.length;j++){try{localStorage.setItem(ls[j].name,ls[j].value)}catch(e){}}return;}})()`,
    ).catch(() => {})
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
