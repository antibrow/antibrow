import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { downloadProfileCache, uploadProfileCache } from '../../src/engine/profile-cache'

/** A response whose body opens and then goes quiet forever. */
function stalledResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      // and then nothing, ever
    },
  })
  return new Response(body, { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a stalled archive transfer', () => {
  it('fails instead of holding the launch open forever', async () => {
    vi.stubGlobal('fetch', async () => stalledResponse())
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-'))

    await expect(downloadProfileCache('https://example.com/a.zip', dir, 40)).rejects.toThrow(
      /stall/i,
    )
  })

  it('bounds the upload too', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return Promise.resolve(new Response('', { status: 200 }))
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-'))
    fs.mkdirSync(path.join(dir, 'user-data'), { recursive: true })

    await uploadProfileCache(dir, 'https://example.com/a.zip')
  })

  it('still restores an archive that arrives normally', async () => {
    const { packProfileCache } = await import('../../src/engine/profile-cache')
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-src-'))
    fs.mkdirSync(path.join(src, 'user-data'), { recursive: true })
    fs.writeFileSync(path.join(src, 'persona.json'), '{"kernelVersion":"152"}')
    const zip = packProfileCache(src)

    vi.stubGlobal('fetch', async () => new Response(zip, { status: 200 }))
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-dst-'))

    await expect(downloadProfileCache('https://example.com/a.zip', dest)).resolves.toBe(true)
  })
})
