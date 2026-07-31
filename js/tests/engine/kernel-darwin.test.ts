import { describe, it, expect } from 'vitest'
import {
  KERNEL_VERSIONS,
  kernelAsset,
  kernelAvailableOnPlatform,
  kernelsForPlatform,
  kernelExePath,
  registerKernelVersions,
} from '../../src/engine/downloader'

describe('darwin kernel catalogue', () => {
  it('ships a mac build for 150 but not for 149', () => {
    const v150 = KERNEL_VERSIONS.find((kv) => kv.version === '150.0.7871.182')
    const v149 = KERNEL_VERSIONS.find((kv) => kv.version === '149.0.7827.201')
    expect(v150).toBeDefined()
    expect(v149).toBeDefined()
    expect(kernelAvailableOnPlatform(v150!, 'darwin')).toBe(true)
    expect(kernelAvailableOnPlatform(v149!, 'darwin')).toBe(false)
  })

  it('points at the universal zip and the executable inside the app bundle', () => {
    const v150 = KERNEL_VERSIONS.find((kv) => kv.version === '150.0.7871.182')!
    const asset = kernelAsset(v150, 'darwin')
    expect(asset.downloadUrl).toBe(
      'https://download.antibrow.com/fp-chromium-150-mac-universal.zip',
    )
    expect(asset.exeRelPath).toBe('Chromium.app/Contents/MacOS/Chromium')
  })

  it('resolves the exe path inside the extracted bundle', () => {
    const v150 = KERNEL_VERSIONS.find((kv) => kv.version === '150.0.7871.182')!
    const p = kernelExePath('/cache', v150, 'darwin')
    expect(p).toBe(
      '/cache/kernels/150.0.7871.182/Chromium.app/Contents/MacOS/Chromium',
    )
  })

  it('lists only mac-capable versions for darwin', () => {
    const versions = kernelsForPlatform('darwin').map((kv) => kv.version)
    expect(versions).toContain('150.0.7871.182')
    expect(versions).not.toContain('149.0.7827.201')
  })

  it('maps the mac-universal manifest token onto darwin', () => {
    // registerKernelVersions is the same path fetchRemoteKernelVersions feeds.
    registerKernelVersions([
      {
        version: '151.0.0.1',
        label: 'Chrome 151',
        platforms: {
          darwin: {
            downloadUrl: 'https://download.antibrow.com/fp-chromium-151-mac-universal.zip',
            exeRelPath: 'Chromium.app/Contents/MacOS/Chromium',
            build: 'test',
          },
        },
      },
    ])
    const discovered = kernelsForPlatform('darwin').find((kv) => kv.version === '151.0.0.1')
    expect(discovered).toBeDefined()
    expect(kernelAsset(discovered!, 'darwin').build).toBe('test')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { extractKernelZip } from '../../src/engine/downloader'

describe.skipIf(process.platform !== 'darwin')('darwin extraction', () => {
  it('preserves symlinks that a plain zip reader would flatten', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-'))
    const src = path.join(work, 'src')
    fs.mkdirSync(path.join(src, 'Versions', '150'), { recursive: true })
    fs.writeFileSync(path.join(src, 'Versions', '150', 'payload'), 'binary')
    fs.symlinkSync('150', path.join(src, 'Versions', 'Current'))
    fs.symlinkSync('Versions/Current/payload', path.join(src, 'payload'))

    // Pack exactly the way the kernel is published.
    const zip = path.join(work, 'bundle.zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', src, zip])

    const dest = path.join(work, 'out')
    fs.mkdirSync(dest, { recursive: true })
    return extractKernelZip(zip, dest).then(() => {
      expect(fs.lstatSync(path.join(dest, 'Versions', 'Current')).isSymbolicLink()).toBe(true)
      expect(fs.readlinkSync(path.join(dest, 'Versions', 'Current'))).toBe('150')
      expect(fs.lstatSync(path.join(dest, 'payload')).isSymbolicLink()).toBe(true)
      // Following the link chain must reach the real bytes.
      expect(fs.readFileSync(path.join(dest, 'payload'), 'utf8')).toBe('binary')
      fs.rmSync(work, { recursive: true, force: true })
    })
  })
})

import { verifyDarwinBundleSignature } from '../../src/engine/downloader'

describe.skipIf(process.platform !== 'darwin')('darwin signature self-check', () => {
  it('rejects a bundle whose contents were tampered with', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'))
    const app = path.join(work, 'Probe.app')
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(path.join(work, 'main.c'), 'int main(void){return 0;}\n')
    execFileSync('clang', ['-o', path.join(app, 'Contents', 'MacOS', 'Probe'), path.join(work, 'main.c')])
    fs.writeFileSync(
      path.join(app, 'Contents', 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>' +
      '<key>CFBundleExecutable</key><string>Probe</string>' +
      '<key>CFBundleIdentifier</key><string>com.antibrow.probe</string>' +
      '</dict></plist>\n',
    )
    // Ad-hoc sign, exactly like the published kernel.
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app])
    expect(() => verifyDarwinBundleSignature(app)).not.toThrow()

    // Break a sealed resource: this is what a symlink-flattening unzip does.
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), 'corrupted')
    expect(() => verifyDarwinBundleSignature(app)).toThrow(/signature/i)

    fs.rmSync(work, { recursive: true, force: true })
  })
})
