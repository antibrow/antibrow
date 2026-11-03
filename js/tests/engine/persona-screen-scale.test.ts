import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, expect } from 'vitest'
import { resolvePersonaInit } from '../../src/engine/index'
import { generatePersona, personaToFpConfig, withScreenScale } from '../../src/engine/persona'
import { exportProfileArchive, importProfileArchive } from '../../src/engine/profile-cache'

const opts = { label: 'fixture', timezone: 'Europe/Berlin', hostPlatform: 'darwin' }

describe('screenScale', () => {
  it('pins the dpr to the chosen scale and keeps the physical size a real panel (Chrome rounds 2560/1.5 up to 1707)', () => {
    const physical = new Set(['1920x1080', '1366x768', '1600x900', '2560x1440', '1920x1200', '2560x1600'])
    for (const scale of [100, 125, 150] as const) {
      for (let i = 0; i < 40; i++) {
        const p = generatePersona(153, '153', { screenScale: scale })
        expect(p.devicePixelRatio).toBe(scale / 100)
        expect(physical).toContain(`${Math.floor(p.screenW * p.devicePixelRatio)}x${Math.floor(p.screenH * p.devicePixelRatio)}`)
        expect(p.hostScreen).toBeUndefined()
      }
    }
  })

  it('defaults to a scaled display, never dpr 1', () => {
    for (let i = 0; i < 60; i++) expect([1.25, 1.5]).toContain(generatePersona(153, '153').devicePixelRatio)
  })

  it('host omits the screen block but keeps fallback numbers in persona.json', () => {
    const p = generatePersona(153, '153', { screenScale: 'host' })
    expect(p.hostScreen).toBe(true)
    expect(p.screenW).toBeGreaterThan(0)
    const config = personaToFpConfig(p, opts)
    expect(config).not.toHaveProperty('screen')
    expect(config.navigator).toMatchObject({ platform: 'Win32' })
    expect(personaToFpConfig(generatePersona(153, '153', { screenScale: 125 }), opts).screen)
      .toMatchObject({ devicePixelRatio: 1.25 })
  })

  it('rejects combinations where the screen is not generated', () => {
    expect(() => generatePersona(153, '153', { screenScale: 110 as never })).toThrow(/screenScale/)
    expect(() => generatePersona(153, '153', { screenScale: 125, os: 'macos' })).toThrow(/host/)
    expect(() => generatePersona(153, '153', { screenScale: 125, hardware: 'host' })).toThrow(/host/)
    expect(() => generatePersona(153, '153', { screenScale: 'host', deviceType: 'android' })).toThrow(/Windows/)
  })

  it('openProfile hands the scale to a new profile only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-'))
    expect(await resolvePersonaInit(dir, { screenScale: 150 }, 'darwin')).toMatchObject({ screenScale: 150 })
    fs.writeFileSync(path.join(dir, 'persona.json'), '{}')
    expect(await resolvePersonaInit(dir, { screenScale: 150 }, 'darwin')).toBeUndefined()
  })

  it('survives a .fpprofile round trip', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-src-'))
    fs.mkdirSync(path.join(src, 'user-data'))
    fs.writeFileSync(path.join(src, 'persona.json'), JSON.stringify(generatePersona(153, '153', { screenScale: 'host' })))
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-dst-'))
    importProfileArchive(exportProfileArchive(src, { id: 'a1', name: 'n', kernelVersion: '153' }), dst)
    expect(JSON.parse(fs.readFileSync(path.join(dst, 'persona.json'), 'utf8')).hostScreen).toBe(true)
  })

  it('withScreenScale moves only the screen', () => {
    const p = generatePersona(153, '153', { screenScale: 'host' })
    const moved = withScreenScale(p, 100)
    expect(moved.devicePixelRatio).toBe(1)
    expect(moved.hostScreen).toBeUndefined()
    expect({ ...moved, screenW: 0, screenH: 0, devicePixelRatio: 0 }).toEqual({ ...p, hostScreen: undefined, screenW: 0, screenH: 0, devicePixelRatio: 0 })
    expect(withScreenScale(moved, 'host').hostScreen).toBe(true)
    expect(() => withScreenScale(generatePersona(153, '153', { hardware: 'host' }), 125)).toThrow(/host/)
    expect(() => withScreenScale(generatePersona(153, '153', { os: 'macos' }), 125)).toThrow(/host/)
    expect(() => withScreenScale(generatePersona(153, '153', { deviceType: 'android' }), 125)).toThrow(/Windows/)
  })
})
