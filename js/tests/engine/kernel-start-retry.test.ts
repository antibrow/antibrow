import { describe, it, expect } from 'vitest'
import { KernelStartupCrashError, retryKernelStart } from '../../src/engine/launcher'

const crash = () => new KernelStartupCrashError('Browser exited before CDP ready (code=null, signal=SIGSEGV).')

describe('retryKernelStart', () => {
  it('starts again after a kernel that died before CDP was ready', async () => {
    // Roughly one Linux start in twenty dies in fontconfig while Chromium paints
    // its own "unsupported command-line flag" bar - inside the kernel's statically
    // linked copy, so no host package or font set fixes it. A second attempt on
    // the same profile succeeds, and that is the whole remedy available to us.
    let attempts = 0
    const started = await retryKernelStart(async () => {
      attempts++
      if (attempts < 2) throw crash()
      return 'ws://127.0.0.1:9222/devtools/browser/abc'
    }, { delayMs: 0 })

    expect(started).toBe('ws://127.0.0.1:9222/devtools/browser/abc')
    expect(attempts).toBe(2)
  })

  it('gives up after three attempts and reports the last crash', async () => {
    let attempts = 0
    await expect(retryKernelStart(async () => {
      attempts++
      throw new KernelStartupCrashError(`crash ${attempts}`)
    }, { delayMs: 0 })).rejects.toThrow('crash 3')

    expect(attempts).toBe(3)
  })

  it('does not retry a failure the kernel already explained', async () => {
    // A concurrency cap, a rejected license or a start that hung until the
    // timeout all fail the same way every time; retrying only makes the user
    // wait three times as long for the same message.
    let attempts = 0
    await expect(retryKernelStart(async () => {
      attempts++
      throw new Error('Concurrency limit reached (1)')
    }, { delayMs: 0 })).rejects.toThrow('Concurrency limit reached (1)')

    expect(attempts).toBe(1)
  })
})
