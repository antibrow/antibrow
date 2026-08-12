import { describe, it, expect } from 'vitest'
import { generatePersona } from '../../src/engine/persona'

// UA reduction freezes build and patch at .0.0.0, so a UA carrying the whole
// kernel version is a string no browser emits, and it contradicts the
// uaFullVersion UA-CH group the kernel reports. The tails below deliberately
// differ from that frozen .0.0.0 so the expected substring can never be the
// input literal, which is the only way this assertion discriminates.
describe('persona user agent', () => {
  it('carries the Chrome major, not the kernel version it was built from', () => {
    for (const version of ['150.7.7.7', '149.7.7.7']) {
      const major = parseInt(version, 10)
      const persona = generatePersona(major, version)
      expect(persona.chromeMajor).toBe(major)
      expect(persona.ua).toContain(`Chrome/${major}.0.0.0 Safari/537.36`)
      // The UA platform token has to agree with the Win32 navigator.platform
      // that fp-config makes the kernel report.
      expect(persona.ua).toContain('Windows NT 10.0; Win64; x64')
      expect(persona.kernelVersion).toBe(version)
    }
  })
})
