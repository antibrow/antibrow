import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { exportProfileArchive, importProfileArchive } from '../../src/engine/profile-cache'
import { generatePersona } from '../../src/engine/persona'
import { registerKernelVersions, currentPlatform, ANDROID_MIN_KERNEL_VERSION } from '../../src/engine/downloader'

function profileWith(persona: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-portable-'))
  fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(persona, null, 2))
  return dir
}

describe('portable android profiles', () => {
  const android = generatePersona(151, '151.0.0.0', { deviceType: 'android' })

  // The Android kernel exists only in the manifest, so an import has to be able
  // to see it. `import refuses an unknown android pin` below covers the opposite.
  beforeAll(() => {
    registerKernelVersions([{
      version: ANDROID_MIN_KERNEL_VERSION,
      label: 'Chrome 151',
      platforms: { [currentPlatform()]: { downloadUrl: 'https://example.test/k.zip', exeRelPath: 'chrome', build: '2026-08-07 05:17' } },
    }])
  })

  it('stamps format version 2 so older readers refuse it', () => {
    const dir = profileWith(android)
    const zip = new AdmZip(exportProfileArchive(dir, { name: 'a', kernelVersion: '151.0.0.0' }))
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'))
    expect(manifest.version).toBe(2)
    expect(manifest.profile.persona.device_type).toBe('android')
    expect(manifest.profile.persona.android_model).toBe(android.androidModel)
    expect(manifest.profile.persona.android_os_major).toBe(android.androidOsMajor)
    expect(manifest.profile.persona.captured.max_touch_points).toBe(5)
    expect(manifest.profile.persona.captured.ua_mobile).toBe(true)
    expect(manifest.profile.persona.captured.ua_architecture).toBe('')
    expect(manifest.profile.persona.captured_webgl.VERSION2).toBeDefined()
  })

  it('keeps desktop profiles on format version 1', () => {
    const dir = profileWith(generatePersona(150, '150.0.0.0'))
    const zip = new AdmZip(exportProfileArchive(dir, { name: 'd', kernelVersion: '150.0.0.0' }))
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'))
    expect(manifest.version).toBe(1)
    expect(manifest.profile.persona.device_type).toBeUndefined()
    expect(manifest.profile.persona.captured).toBeUndefined()
  })

  it('round-trips every captured fact', () => {
    const dir = profileWith(android)
    const bytes = exportProfileArchive(dir, { name: 'a', kernelVersion: '151.0.0.0' })
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-restore-'))
    importProfileArchive(bytes, restoreDir)
    const restored = JSON.parse(fs.readFileSync(path.join(restoreDir, 'persona.json'), 'utf8'))
    expect(restored.deviceType).toBe('android')
    expect(restored.androidModel).toBe(android.androidModel)
    expect(restored.androidOsMajor).toBe(android.androidOsMajor)
    expect(restored.captured).toEqual(android.captured)
    expect(restored.capturedWebgl).toEqual(android.capturedWebgl)
  })

  it('round-trips uaMobile: false, which is a captured value and not an absence', () => {
    // Every bundled android row is mobile: true, so the presence guard on this
    // field was never exercised - and the paid desktop path (os=windows) sends
    // exactly `mobile: false`.
    const desktopReal = generatePersona(150, '150.0.0.0')
    desktopReal.deviceType = 'desktop'
    desktopReal.captured = { uaMobile: false, uaArchitecture: '', uaBitness: '', platform: 'Win32' }
    const dir = profileWith(desktopReal)
    const bytes = exportProfileArchive(dir, { name: 'w', kernelVersion: '150.0.0.0' })
    const manifest = JSON.parse(new AdmZip(bytes).getEntry('manifest.json')!.getData().toString('utf8'))
    expect(manifest.profile.persona.captured.ua_mobile).toBe(false)

    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-restore-'))
    importProfileArchive(bytes, restoreDir)
    const restored = JSON.parse(fs.readFileSync(path.join(restoreDir, 'persona.json'), 'utf8'))
    expect(restored.captured.uaMobile).toBe(false)
  })

  it('carries the device type back to the importer instead of dropping it', () => {
    const dir = profileWith(android)
    const bytes = exportProfileArchive(dir, { name: 'a', kernelVersion: '151.0.0.0', realFingerprint: true })
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-meta-'))
    const meta = importProfileArchive(bytes, restoreDir)
    expect(meta.deviceType).toBe('android')
    expect(meta.realFingerprint).toBe(true)
    expect(meta.kernelVersion).toBe(ANDROID_MIN_KERNEL_VERSION)
  })

  it('refuses to export a profile whose identity has not been resolved yet', () => {
    // The desktop app deliberately defers persona.json for android/real-fingerprint
    // profiles. Generating one here would freeze a plain desktop identity onto it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-empty-'))
    expect(() => exportProfileArchive(dir, { name: 'a', deviceType: 'android' })).toThrow(/no identity yet/)
    expect(fs.existsSync(path.join(dir, 'persona.json'))).toBe(false)
  })

  it('refuses to export a row that disagrees with its persona', () => {
    const dir = profileWith(android)
    expect(() => exportProfileArchive(dir, { name: 'a', deviceType: 'desktop' })).toThrow(/mismatch/i)
  })

  it('still refuses a format from the future', () => {
    const dir = profileWith(android)
    const zip = new AdmZip(exportProfileArchive(dir, { name: 'a', kernelVersion: '151.0.0.0' }))
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'))
    manifest.version = 3
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-future-'))
    expect(() => importProfileArchive(zip.toBuffer(), restoreDir)).toThrow(/newer/i)
  })
})
