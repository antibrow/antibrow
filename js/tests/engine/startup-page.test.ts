import { describe, it, expect } from 'vitest'
import type { BrowserContext, Page } from 'playwright-core'
import { ensureStartupPage } from '../../src/engine/launcher'

// macOS launches carry --no-startup-window, so the blank tab win/linux get from
// the kernel has to be created here instead: callers (and the desktop app) count
// on a page existing the moment openProfile resolves.

function fakeContext(pages: string[]): { context: BrowserContext; opened: () => number } {
  const list = pages.map((url) => ({ url: () => url }) as Page)
  let opened = 0
  const context = {
    pages: () => list,
    newPage: async () => {
      opened += 1
      const page = { url: () => 'about:blank' } as Page
      list.push(page)
      return page
    },
  } as unknown as BrowserContext
  return { context, opened: () => opened }
}

describe('ensureStartupPage', () => {
  it('opens the first page when the kernel opened none', async () => {
    const { context, opened } = fakeContext([])
    await ensureStartupPage(context)
    expect(opened()).toBe(1)
    expect(context.pages().map((p) => p.url())).toEqual(['about:blank'])
  })

  it('leaves a page the kernel already opened alone', async () => {
    const { context, opened } = fakeContext(['https://example.com/'])
    await ensureStartupPage(context)
    expect(opened()).toBe(0)
  })

  it('never throws when the browser refuses to open a page', async () => {
    const context = {
      pages: () => [],
      newPage: async () => {
        throw new Error('target closed')
      },
    } as unknown as BrowserContext
    await expect(ensureStartupPage(context)).resolves.toBeUndefined()
  })
})
