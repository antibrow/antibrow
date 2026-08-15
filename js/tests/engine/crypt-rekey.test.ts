import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildRekeyArgs,
  parseRekeyCode,
  profileCryptMarker,
  runCryptRekey,
  CryptRekeyError,
} from '../../src/engine/crypt-rekey'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rekey-'))

function writeLocalState(userDataDir: string, value: unknown): void {
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify(value))
}

describe('buildRekeyArgs', () => {
  it('carries both switches, the user-data-dir and the licence', () => {
    const args = buildRekeyArgs({
      userDataDir: '/p/user-data',
      from: 'a'.repeat(64),
      to: 'none',
      licenseToken: 'tok-1',
      platform: 'darwin',
    })

    expect(args).toContain(`--fp-crypt-rekey-from=${'a'.repeat(64)}`)
    expect(args).toContain('--fp-crypt-rekey-to=none')
    expect(args).toContain('--user-data-dir=/p/user-data')
    expect(args).toContain('--fp-license=tok-1')
  })

  // The kernel rejects the combination outright (BAD_ARGS): with both present
  // there is no answer to "which key wins".
  it('never passes --fp-crypt-key alongside the rekey switches', () => {
    const args = buildRekeyArgs({
      userDataDir: '/p/user-data',
      from: 'b'.repeat(64),
      to: 'none',
      licenseToken: 'tok-1',
      platform: 'darwin',
    })

    expect(args.some((a) => a.startsWith('--fp-crypt-key='))).toBe(false)
  })

  it('adds the linux container switches only on linux', () => {
    const linux = buildRekeyArgs({ userDataDir: '/u', from: 'none', to: 'c'.repeat(64), licenseToken: 't', platform: 'linux' })
    const mac = buildRekeyArgs({ userDataDir: '/u', from: 'none', to: 'c'.repeat(64), licenseToken: 't', platform: 'darwin' })

    expect(linux).toContain('--no-sandbox')
    expect(mac).not.toContain('--no-sandbox')
  })
})

// The prose has already changed once between kernel builds; the token has not.
describe('parseRekeyCode', () => {
  it('reads the token out of a refusal line', () => {
    expect(parseRekeyCode(
      'fp-crypt-rekey: FROM_MISMATCH: --fp-crypt-rekey-from does not match this profile (existing data left untouched)',
    )).toBe('FROM_MISMATCH')
  })

  it('reads the tokens the crypt-key half emits too', () => {
    expect(parseRekeyCode(
      'fp-crypt-key: REKEY_PENDING: this profile is in the middle of a --fp-crypt-rekey conversion; re-run the same rekey command to finish it. Refusing to start.',
    )).toBe('REKEY_PENDING')
    expect(parseRekeyCode(
      'fp-crypt-key: KEY_REQUIRED: this profile requires an external key; none was supplied. Refusing to start (existing data left untouched).',
    )).toBe('KEY_REQUIRED')
  })

  it('says nothing when the output carries no token', () => {
    expect(parseRekeyCode('Segmentation fault')).toBeUndefined()
    expect(parseRekeyCode('')).toBeUndefined()
  })
})

describe('profileCryptMarker', () => {
  it('reports key-bound while the verifier is there', () => {
    const dir = tmp()
    writeLocalState(dir, { fp_crypt: { key_check: 'AAAA' }, user_experience_metrics: {} })

    expect(profileCryptMarker(dir)).toBe('key-bound')
  })

  // A half-converted profile is refused by the kernel at launch, so it is not
  // exportable either - and it is not "plain" just because key_check is gone.
  it('reports key-bound for a pending conversion', () => {
    const dir = tmp()
    writeLocalState(dir, { fp_crypt: { rekey_pending: { from: 'fp1', to: 'fp2', to_check: 'x' } } })

    expect(profileCryptMarker(dir)).toBe('key-bound')
  })

  it('reports plain once the whole fp_crypt block is gone', () => {
    const dir = tmp()
    writeLocalState(dir, { user_experience_metrics: {} })

    expect(profileCryptMarker(dir)).toBe('plain')
  })

  it('reports plain for an explicit null, which is how the kernel leaves it', () => {
    const dir = tmp()
    writeLocalState(dir, { fp_crypt: null })

    expect(profileCryptMarker(dir)).toBe('plain')
  })

  // "Cannot tell" must never read as "no key": that is the answer that ships a
  // broken archive.
  it('reports unreadable for a missing or unparseable Local State', () => {
    const empty = tmp()
    expect(profileCryptMarker(empty)).toBe('unreadable')

    const broken = tmp()
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, 'Local State'), '{not json')
    expect(profileCryptMarker(broken)).toBe('unreadable')
  })
})

// Spawning a stand-in binary needs an executable script, so POSIX only. The
// argv, exit-code and token handling above are platform-independent.
const posix = process.platform === 'win32' ? describe.skip : describe

posix('runCryptRekey drives a real process', () => {
  function fakeKernel(body: string): string {
    const dir = tmp()
    const file = path.join(dir, 'fake-kernel')
    fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
    fs.chmodSync(file, 0o755)
    return file
  }

  it('resolves when the kernel reports OK', async () => {
    const argvFile = path.join(tmp(), 'argv.json')
    const exePath = fakeKernel(
      `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))\n` +
      "console.log('fp-crypt-rekey: OK: 4 files, 210 values converted (0 in Local State)')",
    )

    await runCryptRekey({
      exePath,
      userDataDir: '/p/user-data',
      from: 'd'.repeat(64),
      to: 'none',
      licenseToken: 'tok-9',
    })

    expect(JSON.parse(fs.readFileSync(argvFile, 'utf8'))).toContain(`--fp-crypt-rekey-from=${'d'.repeat(64)}`)
  })

  it('turns a refusal into an error carrying the token and the exit code', async () => {
    const exePath = fakeKernel(
      "console.error('fp-crypt-rekey: FROM_MISMATCH: --fp-crypt-rekey-from does not match this profile (existing data left untouched)')\n" +
      'process.exit(7)',
    )

    const err = await runCryptRekey({
      exePath, userDataDir: '/p/user-data', from: 'e'.repeat(64), to: 'none', licenseToken: 't',
    }).catch((e) => e as CryptRekeyError)

    expect(err).toBeInstanceOf(CryptRekeyError)
    expect((err as CryptRekeyError).code).toBe('FROM_MISMATCH')
    expect((err as CryptRekeyError).exitCode).toBe(7)
  })

  it('fails loudly on a non-zero exit with no token at all', async () => {
    const exePath = fakeKernel('process.exit(1)')

    await expect(runCryptRekey({
      exePath, userDataDir: '/u', from: 'f'.repeat(64), to: 'none', licenseToken: 't',
    })).rejects.toThrow(/exit(ed)? 1|exit code 1/i)
  })

  // The regression this guards: a kernel that does not understand the rekey
  // switches ignores them and opens a full browser instead of exiting, so this
  // never produces a refusal token - it just never exits. The message this
  // produces has to read differently from a refusal, or a timeout is
  // indistinguishable from "kernel said FROM_MISMATCH" in a bug report.
  it('distinguishes a timeout from a refusal', async () => {
    // Never exits on its own within the test's timeout.
    const exePath = fakeKernel('setTimeout(() => {}, 30000)')

    const err = await runCryptRekey({
      exePath, userDataDir: '/u', from: 'g'.repeat(64), to: 'none', licenseToken: 't', timeoutMs: 200,
    }).catch((e) => e as CryptRekeyError)

    expect(err).toBeInstanceOf(CryptRekeyError)
    expect((err as CryptRekeyError).code).toBe('TIMEOUT')
    expect((err as CryptRekeyError).exitCode).toBeNull()
    expect(err.message).toMatch(/did not finish within 200ms|not finish|stopped/i)
    // Must not read like a kernel refusal (a token or "exit code N").
    expect(err.message).not.toMatch(/FROM_MISMATCH|exit code \d/)
  })
})

// The conversion takes a licence slot exactly as a launch does, so a machine
// already running its allowance reports LICENSE - and that cause's fix (close a
// browser) is the opposite of the other three the same token covers.
posix('refusals a user can act on', () => {
  it('says what to do about a licence slot a browser is holding', async () => {
    const dir = tmp()
    const file = path.join(dir, 'fake-kernel')
    // The rekey mode prints its own refusals, licence included, under this prefix.
    fs.writeFileSync(file, "#!/usr/bin/env node\nconsole.error('fp-crypt-rekey: LICENSE: missing, invalid or expired --fp-license')\nprocess.exit(7)\n")
    fs.chmodSync(file, 0o755)

    await expect(runCryptRekey({
      exePath: file, userDataDir: '/u', from: 'a'.repeat(64), to: 'none', licenseToken: 't',
    })).rejects.toThrow(/close one and export again/)
  })
})
