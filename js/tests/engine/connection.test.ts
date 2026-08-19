import { describe, it, expect } from 'vitest'
import { deriveConnection, deviceToPersonaParts, ECT_RTT_THRESHOLDS, generatePersona, personaToFpConfig } from '../../src/engine/persona'
import type { RealDevice } from '../../src/engine/devices'

// Chrome 151 real samples: {4g,200,1.6} and {4g,150,1.45}. rtt is a multiple of 25,
// downlink a multiple of 0.05, and effectiveType is derived from rtt - the three
// must agree with each other.
describe('deriveConnection', () => {
  it('rounds a measured rtt to the 25ms grid Chrome reports on', () => {
    expect(deriveConnection('abc', 187).rtt).toBe(175)
    expect(deriveConnection('abc', 200).rtt).toBe(200)
    expect(deriveConnection('abc', 213).rtt).toBe(225)
  })

  it('clamps a measured rtt into a reportable range', () => {
    expect(deriveConnection('abc', 1).rtt).toBe(25)
    expect(deriveConnection('abc', 99999).rtt).toBe(3000)
  })

  it('derives effectiveType from rtt at the documented thresholds', () => {
    const at = (rtt: number) => deriveConnection('abc', rtt).effectiveType
    expect(at(ECT_RTT_THRESHOLDS.fourG - 25)).toBe('4g')
    expect(at(ECT_RTT_THRESHOLDS.fourG + 25)).toBe('3g')
    expect(at(ECT_RTT_THRESHOLDS.threeG + 25)).toBe('2g')
    expect(at(ECT_RTT_THRESHOLDS.twoG + 25)).toBe('slow-2g')
  })

  it('keeps downlink on the 0.025 grid (25 kbps, Chrome\'s own step) and inside the range its effectiveType allows', () => {
    for (const seed of ['0011223344556677', 'ffeeddccbbaa9988', 'a1b2c3d4e5f60718']) {
      const fast = deriveConnection(seed, 100)
      expect(fast.effectiveType).toBe('4g')
      expect(fast.downlink).toBeGreaterThanOrEqual(1)
      expect(fast.downlink).toBeLessThanOrEqual(10)
      expect(Math.round(fast.downlink * 1000) % 25).toBe(0)

      // '3g' with 10 Mbps is the same kind of contradiction as '4g' with rtt 800.
      const slow = deriveConnection(seed, 600)
      expect(slow.effectiveType).toBe('3g')
      expect(slow.downlink).toBeGreaterThanOrEqual(0.4)
      expect(slow.downlink).toBeLessThanOrEqual(1.5)
      expect(Math.round(slow.downlink * 1000) % 25).toBe(0)
    }
  })

  it('falls back to a seed-derived 4g trio when nothing was measured', () => {
    for (const rttMs of [undefined, 0, -1, Number.NaN]) {
      const c = deriveConnection('0011223344556677', rttMs)
      expect(c.effectiveType).toBe('4g')
      expect(c.rtt).toBeLessThan(ECT_RTT_THRESHOLDS.fourG)
      expect(c.rtt % 25).toBe(0)
    }
  })

  it('is stable for one seed and different across seeds', () => {
    expect(deriveConnection('0011223344556677')).toEqual(deriveConnection('0011223344556677'))
    const seen = new Set(
      ['0011223344556677', 'ffeeddccbbaa9988', 'a1b2c3d4e5f60718', '1234567890abcdef']
        .map((s) => deriveConnection(s).downlink),
    )
    // The whole point: this used to be one constant for every user.
    expect(seen.size).toBeGreaterThan(1)
  })

  // Hardcoded, not recomputed from the formula: this is the cross-SDK contract
  // the Python mirror must reproduce byte-for-byte, so a constant drifting here
  // (the 50/9/25 fallback, the minDl/maxDl split, ...) must fail loudly.
  it('matches known golden values for fixed seeds', () => {
    expect(deriveConnection('0011223344556677')).toEqual({ effectiveType: '4g', rtt: 175, downlink: 3.55 })
    expect(deriveConnection('0011223344556677', 600)).toEqual({ effectiveType: '3g', rtt: 600, downlink: 0.75 })

    expect(deriveConnection('ffeeddccbbaa9988')).toEqual({ effectiveType: '4g', rtt: 225, downlink: 9.425 })
    expect(deriveConnection('ffeeddccbbaa9988', 600)).toEqual({ effectiveType: '3g', rtt: 600, downlink: 1.025 })

    expect(deriveConnection('a1b2c3d4e5f60718')).toEqual({ effectiveType: '4g', rtt: 225, downlink: 1.775 })
    expect(deriveConnection('a1b2c3d4e5f60718', 600)).toEqual({ effectiveType: '3g', rtt: 600, downlink: 1.25 })

    expect(deriveConnection('1234567890abcdef')).toEqual({ effectiveType: '4g', rtt: 200, downlink: 1.975 })
    expect(deriveConnection('1234567890abcdef', 600)).toEqual({ effectiveType: '3g', rtt: 600, downlink: 1.45 })
  })

  // A fractional rttMs is not a hypothetical: geoip.py's monotonic-clock probe
  // is the only kind of rtt the Python SDK ever produces in production, and
  // 462.5/25 = 18.5 is exactly the half-way case where JS's half-up Math.round
  // and Python's banker's-rounding round() could part company (floor(x+0.5) is
  // why they don't).
  it('matches known golden values for a fractional rttMs', () => {
    expect(deriveConnection('0011223344556677', 462.5)).toEqual({ effectiveType: '3g', rtt: 475, downlink: 0.75 })
    expect(deriveConnection('0011223344556677', 462.7)).toEqual({ effectiveType: '3g', rtt: 475, downlink: 0.75 })

    expect(deriveConnection('ffeeddccbbaa9988', 462.5)).toEqual({ effectiveType: '3g', rtt: 475, downlink: 1.025 })
    expect(deriveConnection('ffeeddccbbaa9988', 462.7)).toEqual({ effectiveType: '3g', rtt: 475, downlink: 1.025 })

    expect(deriveConnection('a1b2c3d4e5f60718', 462.5)).toEqual({ effectiveType: '3g', rtt: 475, downlink: 1.25 })
    expect(deriveConnection('a1b2c3d4e5f60718', 462.7)).toEqual({ effectiveType: '3g', rtt: 475, downlink: 1.25 })

    expect(deriveConnection('1234567890abcdef', 462.5)).toEqual({ effectiveType: '3g', rtt: 475, downlink: 1.45 })
    expect(deriveConnection('1234567890abcdef', 462.7)).toEqual({ effectiveType: '3g', rtt: 475, downlink: 1.45 })
  })
})

// One real Windows box out of the device library. rtt 250 / 4g / 4.5 is a trio
// Chrome itself emitted, so it hangs together; the point of these tests is that
// nothing ever ships two thirds of it beside a third from somewhere else.
const CORPUS_DEVICE: RealDevice = {
  os: 'windows',
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36',
  navigator: { hardwareConcurrency: 16, deviceMemory: 32 },
  screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
  connection: { effectiveType: '4g', rtt: 250, downlink: 4.5, type: 'wifi' },
  webgl: { unmaskedVendor: 'Google Inc. (Intel)', unmaskedRenderer: 'ANGLE (Intel, …)' },
}

describe('a replayed device\'s connection', () => {
  const captured = deviceToPersonaParts(CORPUS_DEVICE, 151).captured

  it('carries the whole trio, not just effectiveType', () => {
    expect(captured).toMatchObject({ connectionEffectiveType: '4g', connectionRtt: 250, connectionDownlink: 4.5 })
  })

  it('replays that trio verbatim when nothing was measured', () => {
    expect(deriveConnection('0011223344556677', undefined, captured))
      .toEqual({ effectiveType: '4g', rtt: 250, downlink: 4.5 })
  })

  it('is discarded whole once a proxy rtt is measured', () => {
    // The bug: effectiveType came from the corpus machine while rtt came from
    // the proxy probe, shipping '4g' beside rtt 400 - a contradiction Chrome's
    // own thresholds rule out, and one a site can catch by timing us itself.
    const c = deriveConnection('0011223344556677', 400, captured)
    expect(c).toEqual(deriveConnection('0011223344556677', 400))
    expect(c.effectiveType).toBe('3g')
  })

  it('never mixes when only part of the trio was captured', () => {
    // What every persona.json written before the trio travelled together looks
    // like. Half a reading is worse than none: derive all three instead.
    const partial = { connectionEffectiveType: '4g' }
    expect(deriveConnection('0011223344556677', undefined, partial))
      .toEqual(deriveConnection('0011223344556677'))
  })

  it('keeps effectiveType agreeing with rtt through personaToFpConfig', () => {
    const persona = generatePersona(151, '151', { device: CORPUS_DEVICE })
    const cfg = personaToFpConfig(persona, { label: 'p', timezone: 'UTC', rttMs: 400 }) as
      { connection: { effectiveType: string; rtt: number; downlink: number; type?: string } }
    expect(cfg.connection.rtt).toBe(400)
    expect(cfg.connection.effectiveType).toBe('3g')
    expect(cfg.connection.downlink).toBeLessThanOrEqual(1.5)
    // The medium is not latency-derived, so it still comes from the corpus row.
    expect(cfg.connection.type).toBe('wifi')
  })
})

describe('personaToFpConfig connection', () => {
  it('uses the measured rtt when one was passed', () => {
    const persona = generatePersona(150, '150.0.0.0')
    const cfg = personaToFpConfig(persona, { label: 'p', timezone: 'UTC', rttMs: 640 }) as
      { connection: { effectiveType: string; rtt: number; downlink: number } }
    expect(cfg.connection).toEqual(deriveConnection(persona.seed, 640))
    expect(cfg.connection.effectiveType).toBe('3g')
  })

  it('no longer emits the old hardcoded trio for every profile', () => {
    // Fixed seeds, not generated ones: rtt lands on a 25ms grid that includes
    // 100 and downlink tops out at exactly 10, so a random persona hits the old
    // constant roughly once in three thousand runs and turns this into a flake.
    const cfg = (seed: string) => {
      const persona = { ...generatePersona(150, '150.0.0.0'), seed }
      return (personaToFpConfig(persona, { label: 'p', timezone: 'UTC' }) as { connection: unknown }).connection
    }
    for (const seed of ['0011223344556677', 'ffeeddccbbaa9988', 'a1b2c3d4e5f60718']) {
      expect(cfg(seed)).not.toEqual({ effectiveType: '4g', rtt: 100, downlink: 10 })
      expect(cfg(seed)).toEqual(deriveConnection(seed))
    }
  })
})
