import { describe, expect, it } from 'vitest'
import { restoreBrowserDownloads } from '../../src/engine/launcher'

describe('restoreBrowserDownloads', () => {
  it('hands downloads back to the browser for every context', async () => {
    const sent: Array<[string, unknown]> = []
    const pw = {
      newBrowserCDPSession: async () => ({
        send: async (method: string, params: unknown) => { sent.push([method, params]) },
      }),
    }
    await restoreBrowserDownloads(pw as never)
    expect(sent).toEqual([['Browser.setDownloadBehavior', { behavior: 'default' }]])
  })
})
