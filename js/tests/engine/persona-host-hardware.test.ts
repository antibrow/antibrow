import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, expect } from 'vitest'
import { resolvePersonaInit } from '../../src/engine/index'
import {
  generatePersona, withKernelVersion, sanitizePersonaGpu, personaHostWarnings, assertPersonaOs, usesHostHardware,
  personaToFpConfig, HOST_HARDWARE_UNAVAILABLE, MACOS_PERSONA_ON_FOREIGN_HOST, type Persona,
} from '../../src/engine/persona'

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'))

const opts = {
  label: 'fixture', timezone: 'Europe/Berlin', publicIp: '203.0.113.7', apiLogPath: '/p/fp-api-log.jsonl',
}
const hostPersona = (): Persona => fixture('windows-host-persona.json')

describe('Windows host hardware', () => {
  it('generates a windows persona with generated hardware values marked host', () => {
    const p = generatePersona(153, '153', { hardware: 'host' })
    expect(p.hardware).toBe('host')
    expect('os' in p).toBe(false)
    expect(p.ua).toContain('Windows NT 10.0')
    expect(p.hardwareConcurrency).toBeGreaterThan(0)
    expect(p.deviceMemory).toBeGreaterThan(0)
    expect(p.screenW).toBeGreaterThan(0)
    expect(p.gpuRenderer).not.toBe('')
  })

  it('writes no hardware key for generated or absent', () => {
    expect('hardware' in generatePersona(153, '153', { hardware: 'generated' })).toBe(false)
    expect('hardware' in generatePersona(153, '153')).toBe(false)
  })

  it('rejects bad hardware arguments', () => {
    expect(() => generatePersona(153, '153', { hardware: 'x' as never })).toThrow(/hardware/)
    expect(() => generatePersona(153, '153', { hardware: 'host', deviceType: 'android' })).toThrow(/desktop/)
    expect(() => generatePersona(153, '153', { hardware: 'generated', os: 'macos' })).toThrow(/macOS/)
    expect(() => assertPersonaOs({ hardware: 'host' }, true)).toThrow(/real/i)
    expect(() => assertPersonaOs({ os: 'macos', hardware: 'host' })).not.toThrow()
  })

  it('sends only the identity whitelist on a windows host', () => {
    expect(personaToFpConfig(hostPersona(), { ...opts, hostPlatform: 'win32' })).toEqual(fixture('windows-host-fp-config.json'))
  })

  it('falls back to generated hardware on a foreign host', () => {
    const p = hostPersona()
    const { hardware: _, ...plain } = p
    for (const hostPlatform of ['darwin', 'linux'] as const) {
      const out = personaToFpConfig(p, { ...opts, hostPlatform })
      expect(out).toEqual(personaToFpConfig(plain, { ...opts, hostPlatform }))
      expect((out.navigator as Record<string, unknown>).platform).toBe('Win32')
      expect(out).toHaveProperty('screen')
      expect(out).toHaveProperty('webgl')
    }
  })

  it('keeps generating hardware for a windows persona without the field', () => {
    const { hardware: _, ...plain } = hostPersona()
    const out = personaToFpConfig(plain, { ...opts, hostPlatform: 'win32' })
    expect(out).toHaveProperty('screen')
    expect(out).toHaveProperty('webgl')
  })

  it('turns canvas and webgl off on the host branch when canvasNoise is false', () => {
    const out = personaToFpConfig(hostPersona(), { ...opts, hostPlatform: 'win32', canvasNoise: false }) as any
    expect(out.canvas.mode).toBe('off')
    expect(out.webgl).toEqual({ mode: 'off' })
  })

  it('warns only for host hardware on a non-windows host', () => {
    const p = { hardware: 'host' as const }
    expect(personaHostWarnings(p, 'win32')).toEqual([])
    expect(personaHostWarnings(p, 'darwin')).toEqual([HOST_HARDWARE_UNAVAILABLE])
    expect(personaHostWarnings(p, 'linux')).toEqual([HOST_HARDWARE_UNAVAILABLE])
    expect(HOST_HARDWARE_UNAVAILABLE).toBe('host-hardware-unavailable')
    expect(personaHostWarnings({}, 'darwin')).toEqual([])
    expect(personaHostWarnings({ hardware: 'bogus' } as unknown as Persona, 'darwin')).toEqual([])
    expect(personaHostWarnings({ os: 'macos' }, 'win32')).toEqual([MACOS_PERSONA_ON_FOREIGN_HOST])
    expect(personaHostWarnings({ os: 'macos' }, 'darwin')).toEqual([])
  })

  it('reports who uses host hardware', () => {
    expect(usesHostHardware({ os: 'macos' })).toBe(true)
    expect(usesHostHardware({ hardware: 'host' })).toBe(true)
    expect(usesHostHardware({})).toBe(false)
    expect(usesHostHardware({ deviceType: 'android', hardware: 'host' })).toBe(false)
  })

  it('keeps hardware across a kernel switch', () => {
    const moved = withKernelVersion(hostPersona(), '152')
    expect(moved.hardware).toBe('host')
    expect(moved.ua).toContain('Chrome/152')
  })

  it('still repairs a blocked GPU vendor', () => {
    const p = { ...hostPersona(), gpuVendor: 'Imagination Technologies' }
    expect(sanitizePersonaGpu(p).gpuVendor).toBe('ARM')
  })
})

describe('resolvePersonaInit hardware default', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-init-'))

  it('defaults a new windows desktop profile to host on a win32 host only', async () => {
    expect(await resolvePersonaInit(dir(), {}, 'win32')).toEqual({ deviceType: undefined, device: undefined, os: undefined, hardware: 'host' })
    expect(await resolvePersonaInit(dir(), {}, 'darwin')).toBeUndefined()
    expect(await resolvePersonaInit(dir(), {}, 'linux')).toBeUndefined()
  })

  it('honors an explicit choice', async () => {
    expect((await resolvePersonaInit(dir(), { hardware: 'generated' }, 'win32'))?.hardware).toBe('generated')
    expect((await resolvePersonaInit(dir(), { hardware: 'host' }, 'darwin'))?.hardware).toBe('host')
  })

  it('does not default host for macos, android or real fingerprints', async () => {
    expect((await resolvePersonaInit(dir(), { os: 'macos' }, 'darwin'))?.hardware).toBeUndefined()
    expect((await resolvePersonaInit(dir(), { deviceType: 'android' }, 'win32'))?.hardware).toBeUndefined()
    const init = await resolvePersonaInit(dir(), { realFingerprint: true, key: 'k' }, 'win32').catch(() => 'threw')
    expect(typeof init === 'object' ? init?.hardware : undefined).toBeUndefined()
  })

  it('rejects contradictory input', async () => {
    await expect(resolvePersonaInit(dir(), { hardware: 'host', deviceType: 'android' }, 'win32')).rejects.toThrow()
    await expect(resolvePersonaInit(dir(), { hardware: 'host', realFingerprint: true, key: 'k' }, 'win32')).rejects.toThrow(/real/i)
  })

  it('ignores hardware for an existing persona', async () => {
    const d = dir()
    fs.writeFileSync(path.join(d, 'persona.json'), '{}')
    expect(await resolvePersonaInit(d, { hardware: 'host' }, 'win32')).toBeUndefined()
  })
})
