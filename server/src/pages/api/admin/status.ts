import type { APIRoute } from 'astro'
import nacl from 'tweetnacl'
import { getConfig } from '../../../core/config'
import { handleError, jsonResponse } from '../../../core/errors'
import { mintLicenseToken } from '../../../core/license'
import { createS3 } from '../../../core/s3'
import { adminDb, assertAdmin } from '../../../lib/admin-body'

export const prerender = false

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function licenseKeyStatus(seedHex: string): 'ok' | 'invalid' {
  try {
    if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) return 'invalid'
    const seed = Uint8Array.from(seedHex.match(/../g)!, (h) => parseInt(h, 16))
    const { publicKey } = nacl.sign.keyPair.fromSeed(seed)
    const [payload, sig] = mintLicenseToken(seedHex, 1).token.split('.')
    const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return nacl.sign.detached.verify(bytes(payload!), bytes(sig!), publicKey) ? 'ok' : 'invalid'
  } catch {
    return 'invalid'
  }
}

export const GET: APIRoute = async ({ locals }) => {
  try {
    assertAdmin(locals)
    const cfg = getConfig(locals)
    let db = 'ok'
    try {
      await adminDb(locals).$queryRaw`SELECT 1`
    } catch (e) {
      db = message(e)
    }
    let s3 = 'unconfigured'
    if (cfg.s3) {
      try {
        // Listing fails on a missing bucket or bad credentials, which a HEAD on a missing key would not show.
        await createS3(cfg.s3).listObjects('status-probe/')
        s3 = 'ok'
      } catch (e) {
        s3 = message(e)
      }
    }
    return jsonResponse({ db, s3, licenseKey: licenseKeyStatus(cfg.licensePrivKey) })
  } catch (error) {
    return handleError(error)
  }
}
