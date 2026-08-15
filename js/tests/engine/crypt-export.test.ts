import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { exportProfileArchive } from '../../src/engine/profile-cache'
import { exportProfileArchiveAsync } from '../../src/engine/crypt-rekey'
import { isProfileEncrypted, markProfileEncrypted } from '../../src/engine/profile-dir'

// Exporting an encrypted profile packs a converted COPY: the recipient holds no
// key, so an archive of the directory as it stands is a file nobody can open.

const KEY = 'a1'.repeat(32)
const META = { id: 'p-1', name: 'shop-01', kernelVersion: '151' }

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crypt-export-'))

function seed(dir: string, opts: { encrypted: boolean }): void {
  fs.mkdirSync(path.join(dir, 'user-data', 'Default'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ kernelVersion: '151' }))
  fs.writeFileSync(
    path.join(dir, 'user-data', 'Local State'),
    JSON.stringify(opts.encrypted ? { fp_crypt: { key_check: 'KC' }, variations_seed: 'v' } : { variations_seed: 'v' }),
  )
  fs.writeFileSync(
    path.join(dir, 'user-data', 'Default', 'Cookies'),
    Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from(opts.encrypted ? 'fp2SECRET' : 'fp1SECRET')]),
  )
  if (opts.encrypted) markProfileEncrypted(dir)
}

/** What the kernel does: drop the fp_crypt block, re-tag the ciphertext fp2 -> fp1. */
function convert(userDataDir: string): void {
  const localState = path.join(userDataDir, 'Local State')
  const parsed = JSON.parse(fs.readFileSync(localState, 'utf8')) as Record<string, unknown>
  delete parsed.fp_crypt
  fs.writeFileSync(localState, JSON.stringify(parsed))
  const cookies = path.join(userDataDir, 'Default', 'Cookies')
  fs.writeFileSync(cookies, Buffer.from(fs.readFileSync(cookies).toString('binary').replace('fp2', 'fp1'), 'binary'))
}

function entry(buf: Buffer, name: string): Buffer {
  const e = new AdmZip(buf).getEntry(name)
  if (!e) throw new Error(`archive has no ${name}`)
  return e.getData()
}

describe('exporting an encrypted profile', () => {
  it('packs data that opens with no key and leaves the original encrypted', async () => {
    const src = tmp()
    seed(src, { encrypted: true })
    const staging = tmp()
    const rekey = vi.fn(async (req: { userDataDir: string; from: string; to: string }) => convert(req.userDataDir))

    const buf = await exportProfileArchiveAsync(src, META, { cryptKey: KEY, tmpDir: staging, rekey })

    expect(JSON.parse(entry(buf, 'user-data/Local State').toString('utf8')).fp_crypt).toBeUndefined()
    expect(entry(buf, 'user-data/Default/Cookies').toString('binary')).toContain('fp1SECRET')
    expect(entry(buf, 'user-data/Default/Cookies').toString('binary')).not.toContain('fp2')
    // The source directory is not the thing being converted.
    expect(rekey.mock.calls[0][0].userDataDir.startsWith(src)).toBe(false)
    expect(rekey.mock.calls[0][0]).toMatchObject({ from: KEY, to: 'none' })
    // Original untouched: still key-bound, still launchable with its key.
    expect(JSON.parse(fs.readFileSync(path.join(src, 'user-data', 'Local State'), 'utf8')).fp_crypt)
      .toEqual({ key_check: 'KC' })
    expect(fs.readFileSync(path.join(src, 'user-data', 'Default', 'Cookies')).toString('binary')).toContain('fp2SECRET')
    expect(isProfileEncrypted(src)).toBe(true)
  })

  // The manifest id falls back to the directory name, and the copy is not named
  // after the profile.
  it('keeps the profile id even though the pack runs on a copy', async () => {
    const src = tmp()
    seed(src, { encrypted: true })

    const buf = await exportProfileArchiveAsync(src, { name: 'shop-01' }, {
      cryptKey: KEY, tmpDir: tmp(), rekey: async (req) => convert(req.userDataDir),
    })

    expect(JSON.parse(entry(buf, 'manifest.json').toString('utf8')).profile.id).toBe(path.basename(src))
  })

  // The regression that matters: Chromium ignores switches it does not know, so
  // a kernel without the rekey feature starts, converts nothing and exits 0.
  it('aborts when the conversion silently did nothing', async () => {
    const src = tmp()
    seed(src, { encrypted: true })
    const staging = tmp()

    await expect(exportProfileArchiveAsync(src, META, {
      cryptKey: KEY, tmpDir: staging, rekey: async () => {},
    })).rejects.toThrow(/still encrypted|did not convert|does not support/i)
  })

  it('aborts when the kernel refuses', async () => {
    const src = tmp()
    seed(src, { encrypted: true })

    await expect(exportProfileArchiveAsync(src, META, {
      cryptKey: KEY,
      tmpDir: tmp(),
      rekey: async () => { throw new Error('fp-crypt-rekey: FROM_MISMATCH: ...') },
    })).rejects.toThrow(/FROM_MISMATCH/)
  })

  it('refuses a profile whose records claim a key its data does not carry', async () => {
    const src = tmp()
    seed(src, { encrypted: false })
    markProfileEncrypted(src)
    const rekey = vi.fn()

    await expect(exportProfileArchiveAsync(src, META, { cryptKey: KEY, tmpDir: tmp(), rekey }))
      .rejects.toThrow(/encryption/i)
    expect(rekey).not.toHaveBeenCalled()
  })

  it('needs a key: no key, no export - never a silent plain pack', async () => {
    const src = tmp()
    seed(src, { encrypted: true })
    const rekey = vi.fn()

    await expect(exportProfileArchiveAsync(src, META, { tmpDir: tmp(), rekey })).rejects.toThrow(/key/i)
    expect(rekey).not.toHaveBeenCalled()
  })
})

describe('the temporary copy', () => {
  it('is gone after a successful export', async () => {
    const src = tmp()
    seed(src, { encrypted: true })
    const staging = tmp()

    await exportProfileArchiveAsync(src, META, {
      cryptKey: KEY, tmpDir: staging, rekey: async (req) => convert(req.userDataDir),
    })

    expect(fs.readdirSync(staging)).toEqual([])
  })

  it('is gone after a failed export', async () => {
    const src = tmp()
    seed(src, { encrypted: true })
    const staging = tmp()

    await expect(exportProfileArchiveAsync(src, META, {
      cryptKey: KEY, tmpDir: staging, rekey: async () => {},
    })).rejects.toThrow()

    expect(fs.readdirSync(staging)).toEqual([])
  })
})

describe('exporting an unencrypted profile', () => {
  it('produces exactly what the synchronous export produces, with no kernel run', async () => {
    const src = tmp()
    seed(src, { encrypted: false })
    const staging = tmp()
    const rekey = vi.fn()

    const buf = await exportProfileArchiveAsync(src, META, { tmpDir: staging, rekey })

    const expected = new AdmZip(exportProfileArchive(src, META))
    const got = new AdmZip(buf)
    expect(got.getEntries().map((e) => e.entryName).sort()).toEqual(expected.getEntries().map((e) => e.entryName).sort())
    for (const e of expected.getEntries()) {
      expect(got.getEntry(e.entryName)?.getData()).toEqual(e.getData())
    }
    expect(rekey).not.toHaveBeenCalled()
    expect(fs.readdirSync(staging)).toEqual([])
  })

  it('still refuses a profile with no identity yet, exactly as the sync export does', async () => {
    const src = tmp()
    fs.mkdirSync(path.join(src, 'user-data'), { recursive: true })

    await expect(exportProfileArchiveAsync(src, META, { tmpDir: tmp() })).rejects.toThrow(/no identity yet/)
  })
})
