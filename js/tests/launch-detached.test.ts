import { describe, expect, it } from 'vitest'

import { buildOpenProfileOptions } from '../src/browser'

const base = {
  key: 'k',
  server: 's',
  profileName: 'demo',
  licenseToken: 't',
  archive: {},
  cacheDir: '/cache',
  temporary: false,
  licenseSync: true,
} as unknown as Parameters<typeof buildOpenProfileOptions>[0]

describe('detached launches', () => {
  it('are not tracked, so the kernel survives this process on purpose', () => {
    const built = buildOpenProfileOptions({ ...base, options: { detached: true } } as never)

    expect(built.detached).toBe(true)
  })

  it('are off by default - an untracked kernel is the leak, not the feature', () => {
    const built = buildOpenProfileOptions({ ...base, options: {} } as never)

    expect(built.detached).toBeFalsy()
  })
})

describe('the public launch timeout', () => {
  it('reaches the engine as the total budget', () => {
    const built = buildOpenProfileOptions({ ...base, options: { timeoutMs: 42_000 } } as never)

    expect(built.timeoutMs).toBe(42_000)
  })
})

describe('extra Chromium switches', () => {
  it('reach the engine from the public launch option', () => {
    const built = buildOpenProfileOptions({ ...base, options: { args: ['--mute-audio'] } } as never)

    expect(built.args).toEqual(['--mute-audio'])
  })
})
