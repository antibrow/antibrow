import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generatePersona, loadOrGeneratePersona, sanitizePersonaGpu } from '../../src/engine/persona'
import { ANDROID_FALLBACK_DEVICES } from '../../src/engine/android-devices'
import type { RealDevice } from '../../src/engine/devices'

const BASE = ANDROID_FALLBACK_DEVICES[0]
const TAINTED: RealDevice = {
  ...BASE,
  webgl: {
    ...BASE.webgl,
    unmaskedVendor: 'Google Inc. (Imagination Technologies)',
    unmaskedRenderer: 'ANGLE (Imagination Technologies, PowerVR Rogue GE8322, OpenGL ES 3.2 build 1.13@5776728)',
  },
}

describe('blocked GPU vendor token', () => {
  it('swaps the vendor out of a device row and keeps the model', () => {
    const persona = generatePersona(151, '151', { device: TAINTED })
    expect(persona.gpuVendor).toBe('Google Inc. (ARM)')
    expect(persona.gpuRenderer).toBe('ANGLE (ARM, PowerVR Rogue GE8322, OpenGL ES 3.2 build 1.13@5776728)')
  })

  it('leaves a persona that never carried the token alone', () => {
    const persona = generatePersona(151, '151', { deviceType: 'android' })
    expect(sanitizePersonaGpu(persona)).toBe(persona)
  })

  it('touches nothing but the two GPU strings', () => {
    const before = generatePersona(151, '151', { deviceType: 'android' })
    const tainted = { ...before, gpuVendor: 'Google Inc. (Imagination Technologies)' }
    const after = sanitizePersonaGpu(tainted)
    expect(after.gpuVendor).toBe('Google Inc. (ARM)')
    expect({ ...after, gpuVendor: '' }).toEqual({ ...tainted, gpuVendor: '' })
  })
})

describe('repair on load', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-gpu-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('repairs and persists a profile written before the guard', () => {
    const stale = {
      ...generatePersona(151, '151', { deviceType: 'android' }),
      gpuVendor: 'Google Inc. (Imagination Technologies)',
      gpuRenderer: 'ANGLE (Imagination Technologies, PowerVR Rogue GE8320, OpenGL ES 3.2 build 1.10@5187610)',
    }
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(stale, null, 2))

    const loaded = loadOrGeneratePersona(dir, '151')
    expect(loaded.gpuVendor).toBe('Google Inc. (ARM)')
    expect(loaded.gpuRenderer).toBe('ANGLE (ARM, PowerVR Rogue GE8320, OpenGL ES 3.2 build 1.10@5187610)')
    expect(loaded.seed).toBe(stale.seed)

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8'))
    expect(onDisk.gpuVendor).toBe('Google Inc. (ARM)')
    expect(onDisk.gpuRenderer).toBe(loaded.gpuRenderer)
  })

  it('does not rewrite a clean persona', () => {
    const clean = generatePersona(151, '151', { deviceType: 'android' })
    const file = path.join(dir, 'persona.json')
    fs.writeFileSync(file, JSON.stringify(clean, null, 2))
    const before = fs.statSync(file).mtimeMs

    loadOrGeneratePersona(dir, '151')

    expect(fs.statSync(file).mtimeMs).toBe(before)
  })
})
