import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importProfileArchive } from '../../src/engine/profile-cache'
import { registerKernelVersions, currentPlatform, DEFAULT_KERNEL_VERSION } from '../../src/engine/downloader'
import type { Persona } from '../../src/engine/persona'

// Isolated from profile-cache.test.ts because registering a kernel mutates
// module state: there, 149 is absent on every platform, so a legacy pin resolves
// through the *fallback* and the normalize-then-match branch is never taken.
let dst: string

beforeEach(() => {
  dst = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-legacy-kv-'))
  registerKernelVersions([
    {
      version: '149',
      label: 'Chrome 149',
      platforms: { [currentPlatform()]: { downloadUrl: 'https://x/149.zip', exeRelPath: 'chrome' } },
    },
  ])
})

afterEach(() => {
  fs.rmSync(dst, { recursive: true, force: true })
})

function launcherArchive(kernelVersion: string): Buffer {
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    format: 'fp-launcher-profile',
    version: 1,
    profile: {
      id: 'a1b2c3d4e5f60718',
      name: 'Berlin-01',
      kernel_version: kernelVersion,
      persona: {
        seed: '0123456789abcdef',
        canvas_seed: 'aaaaaaaaaaaaaaaa',
        audio_seed: 'bbbbbbbbbbbbbbbb',
        domrect_seed: 'cccccccccccccccc',
        chrome_major: 149,
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        hardware_concurrency: 12,
        device_memory: 16,
        screen_w: 1536,
        screen_h: 864,
        device_pixel_ratio: 1.25,
        gpu_vendor: 'Google Inc. (NVIDIA)',
        gpu_renderer: 'ANGLE (NVIDIA)',
        languages: ['de-DE', 'de', 'en'],
        timezone: 'Europe/Berlin',
      },
    },
  })))
  return zip.toBuffer()
}

describe('importing a profile pinned to a legacy full version', () => {
  it('lands on the same-major catalogue entry, not on the default kernel', () => {
    expect(DEFAULT_KERNEL_VERSION.version).not.toBe('149')
    const meta = importProfileArchive(launcherArchive('149.7.7.7'), dst)
    expect(meta.kernelVersion).toBe('149')
    const persona = JSON.parse(fs.readFileSync(path.join(dst, 'persona.json'), 'utf8')) as Persona
    expect(persona.kernelVersion).toBe('149')
    expect(persona.chromeMajor).toBe(149)
    expect(persona.ua).toContain('Chrome/149.0.0.0 Safari/537.36')
  })
})
