import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, expect } from 'vitest'
import { resolvePersonaInit } from '../../src/engine/index'
import {
  generatePersona, withKernelVersion, sanitizePersonaGpu, personaHostWarnings, isMacPersona, assertPersonaOs,
  personaToFpConfig, MACOS_PERSONA_ON_FOREIGN_HOST, PERSONA_OS_INVALID, type Persona,
} from '../../src/engine/persona'

const MAC_UA = (major: number) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'))

describe('macOS persona', () => {
  it('generates a mac identity that leaves hardware to the host', () => {
    const p = generatePersona(153, '153', { os: 'macos' })
    expect(p.os).toBe('macos')
    expect(p.ua).toBe(MAC_UA(153))
    expect(p.gpuVendor).toBe('')
    expect(p.gpuRenderer).toBe('')
    expect([p.screenW, p.screenH, p.devicePixelRatio, p.hardwareConcurrency, p.deviceMemory]).toEqual([0, 0, 0, 0, 0])
    expect(p.languagesPending).toBe(true)
    expect(p.seed).toMatch(/^[0-9a-f]{16}$/)
    expect(p.canvasSeed).not.toBe(p.seed)
  })

  it('keeps windows personas free of an os key', () => {
    expect('os' in generatePersona(153, '153')).toBe(false)
    expect('os' in generatePersona(153, '153', { os: 'windows' })).toBe(false)
  })

  it('rejects an unknown os, android plus macos, and a real fingerprint plus macos', () => {
    expect(() => generatePersona(153, '153', { os: 'linux' as never })).toThrow(/os/)
    expect(() => generatePersona(153, '153', { os: 'macos', deviceType: 'android' })).toThrow(/desktop/)
    expect(() => assertPersonaOs({ os: 'macos' }, true)).toThrow(/real/i)
    expect(() => assertPersonaOs({ os: 'macos' }, false)).not.toThrow()
  })

  it('moves only the Chrome major when the kernel changes', () => {
    const p = generatePersona(150, '150', { os: 'macos' })
    const moved = withKernelVersion(p, '152')
    expect(moved.ua).toBe(MAC_UA(152))
    expect(moved.os).toBe('macos')
  })

  it('is left alone by the GPU guard', () => {
    const p = generatePersona(153, '153', { os: 'macos' })
    expect(sanitizePersonaGpu(p)).toBe(p)
  })

  it('warns only when a mac persona runs on a non-mac host', () => {
    const mac = { os: 'macos' as const }
    expect(personaHostWarnings(mac, 'darwin')).toEqual([])
    expect(personaHostWarnings(mac, 'win32')).toEqual([MACOS_PERSONA_ON_FOREIGN_HOST])
    expect(personaHostWarnings(mac, 'linux')).toEqual([MACOS_PERSONA_ON_FOREIGN_HOST])
    expect(personaHostWarnings({}, 'win32')).toEqual([])
    expect(personaHostWarnings({ os: 'mac' } as unknown as Persona, 'darwin')).toEqual([PERSONA_OS_INVALID])
  })

  it('treats an invalid or android-bound os as not mac', () => {
    expect(isMacPersona({ os: 'macos' })).toBe(true)
    expect(isMacPersona({})).toBe(false)
    expect(isMacPersona({ os: 'mac' } as unknown as Persona)).toBe(false)
    expect(isMacPersona({ os: 'macos', deviceType: 'android' })).toBe(false)
  })
})

describe('macOS fp-config', () => {
  const persona = fixture('macos-persona.json') as Persona
  const opts = { label: 'fixture', timezone: 'Europe/Berlin', publicIp: '203.0.113.7', apiLogPath: '/p/fp-api-log.jsonl' }

  it('matches the cross-SDK fixture exactly', () => {
    expect(personaToFpConfig(persona, opts)).toEqual(fixture('macos-fp-config.json'))
  })

  it('is the same on every host: nothing Windows-only to alias away', () => {
    for (const hostPlatform of ['darwin', 'win32', 'linux'] as const) {
      expect(personaToFpConfig(persona, { ...opts, hostPlatform })).toEqual(fixture('macos-fp-config.json'))
    }
  })

  it('turns noise off without bringing in a WebGL surface', () => {
    const cfg = personaToFpConfig(persona, { ...opts, canvasNoise: false })
    expect(cfg.canvas).toEqual({ seed: '1111111111111111', mode: 'off' })
    expect(cfg.webgl).toEqual({ mode: 'off' })
  })

  it('disables WebRTC without an exit IP', () => {
    expect(personaToFpConfig(persona, { label: 'x', timezone: 'UTC' }).webrtc).toEqual({ mode: 'disable' })
  })

  it('launches an invalid os as Windows', () => {
    const bad = { ...persona, os: 'mac' } as unknown as Persona
    const cfg = personaToFpConfig({ ...bad, gpuVendor: 'Google Inc. (NVIDIA)', gpuRenderer: 'ANGLE (NVIDIA)', screenW: 1920, screenH: 1080, devicePixelRatio: 1, hardwareConcurrency: 8, deviceMemory: 8 }, opts)
    expect((cfg.navigator as Record<string, unknown>).platform).toBe('Win32')
  })
})

describe('resolvePersonaInit with os', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'macos-init-'))

  it('carries os for a new profile', async () => {
    expect(await resolvePersonaInit(dir(), { os: 'macos' })).toEqual({ deviceType: undefined, device: undefined, os: 'macos' })
  })

  it('refuses macos with a real fingerprint before any server call', async () => {
    await expect(resolvePersonaInit(dir(), { os: 'macos', realFingerprint: true, key: 'k' })).rejects.toThrow(/real/i)
  })

  it('ignores os for a profile that already has a persona', async () => {
    const d = dir()
    fs.writeFileSync(path.join(d, 'persona.json'), '{}')
    expect(await resolvePersonaInit(d, { os: 'macos' })).toBeUndefined()
  })
})
