import { AwsClient } from 'aws4fetch'
import type { OemConfig } from './config'

export type S3Config = NonNullable<OemConfig['s3']>

export interface ListedObject {
  key: string
  lastModified: Date
}

export interface S3Store {
  presignPut(key: string, expiresIn?: number): Promise<string>
  presignGet(key: string, expiresIn?: number): Promise<string>
  /** Null when the object does not exist. */
  headObject(key: string): Promise<{ etag?: string } | null>
  putObject(key: string, body: string | Uint8Array<ArrayBuffer>, contentType?: string, cacheControl?: string): Promise<void>
  /** Null when the object does not exist. */
  getObjectText(key: string): Promise<string | null>
  /** Resolves on success or when the object is already gone. */
  deleteObject(key: string): Promise<void>
  /** One page (up to 1000 keys) of ListObjectsV2 under a prefix. */
  listObjects(prefix: string, continuationToken?: string): Promise<{ objects: ListedObject[]; next?: string }>
  /** Deletes every object under a prefix; returns how many were deleted. */
  deletePrefix(prefix: string): Promise<number>
  /** Creates the bucket if it is missing; an already existing bucket is not an error. */
  ensureBucket(): Promise<void>
}

export function profileStateKey(profileId: string): string {
  return `profile-state/${profileId}.json`
}

export function profileArchiveKey(profileId: string): string {
  return `profile-archive/${profileId}.zip`
}

/** Stores quote ETags; the wire format is bare so a client can compare it to the marker it stored. */
export function normalizeEtag(etag: string | null | undefined): string | undefined {
  const v = (etag ?? '').trim().replace(/^"|"$/g, '')
  return v || undefined
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function parseListObjectsXml(xml: string): { objects: ListedObject[]; next?: string } {
  const objects: ListedObject[] = []
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1] ?? ''
    const key = body.match(/<Key>([\s\S]*?)<\/Key>/)?.[1]
    const mod = body.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1]
    if (!key || !mod) continue
    objects.push({ key: xmlUnescape(key), lastModified: new Date(mod) })
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
  const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]
  return { objects, next: truncated && next ? xmlUnescape(next) : undefined }
}

/** Bucket URL (no trailing slash) for an endpoint in either addressing style. */
export function bucketBase(endpoint: string, bucket: string, addressing: 'path' | 'virtual' = 'path'): string {
  const e = endpoint.replace(/\/+$/, '')
  if (addressing === 'path') return `${e}/${bucket}`
  const u = new URL(e)
  return `${u.protocol}//${bucket}.${u.host}${u.pathname.replace(/\/+$/, '')}`
}

/**
 * S3 client over aws4fetch, path-style by default; `addressing: 'virtual'` puts the bucket in the
 * host (Aliyun OSS requires it). `label` only prefixes error messages.
 * Server-side calls go to the S3 endpoint, never a public CDN domain, whose edge cache can
 * serve a stale copy right after a write.
 */
export function createS3(cfg: S3Config, opts: { label?: string } = {}): S3Store {
  const label = opts.label ?? 'S3'
  const client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey })
  const aws = { service: 's3', region: cfg.region || 'auto' }
  const base = bucketBase(cfg.endpoint, cfg.bucket, cfg.addressing)
  const objectUrl = (key: string) => new URL(`${base}/${key}`)
  // Presigned URLs are handed to clients, so they are signed for the host clients can reach.
  const publicBase = bucketBase(cfg.publicEndpoint || cfg.endpoint, cfg.bucket, cfg.addressing)

  async function presign(method: 'PUT' | 'GET', key: string, expiresIn: number): Promise<string> {
    const url = new URL(`${publicBase}/${key}`)
    url.searchParams.set('X-Amz-Expires', String(expiresIn))
    const signed = await client.sign(new Request(url, { method }), { aws: { ...aws, signQuery: true } })
    return signed.url
  }

  async function deleteObject(key: string): Promise<void> {
    const res = await client.fetch(objectUrl(key), { method: 'DELETE', aws })
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => '')
      throw new Error(`${label} delete failed for "${key}": HTTP ${res.status}. ${detail}`)
    }
  }

  async function listObjects(prefix: string, continuationToken?: string) {
    const url = new URL(base)
    url.searchParams.set('list-type', '2')
    url.searchParams.set('prefix', prefix)
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken)
    const res = await client.fetch(url, { method: 'GET', aws })
    if (!res.ok) throw new Error(`${label} list failed for "${prefix}": HTTP ${res.status}`)
    return parseListObjectsXml(await res.text())
  }

  return {
    presignPut: (key, expiresIn = 3600) => presign('PUT', key, expiresIn),
    presignGet: (key, expiresIn = 3600) => presign('GET', key, expiresIn),

    async headObject(key) {
      const res = await client.fetch(objectUrl(key), { method: 'HEAD', aws })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`${label} HEAD failed: HTTP ${res.status}`)
      return { etag: normalizeEtag(res.headers.get('etag')) }
    },

    async putObject(key, body, contentType, cacheControl) {
      const headers: Record<string, string> = {}
      if (contentType) headers['content-type'] = contentType
      if (cacheControl) headers['cache-control'] = cacheControl
      const res = await client.fetch(objectUrl(key), { method: 'PUT', body, headers, aws })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`${label} put failed for "${key}": HTTP ${res.status}. ${detail}`)
      }
    },

    async getObjectText(key) {
      const res = await client.fetch(objectUrl(key), { method: 'GET', aws })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`${label} get failed for "${key}": HTTP ${res.status}`)
      return await res.text()
    },

    deleteObject,
    listObjects,

    async ensureBucket() {
      const res = await client.fetch(new URL(base), { method: 'PUT', aws })
      if (res.ok) return
      const detail = await res.text().catch(() => '')
      if (res.status === 409 && /BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(detail)) return
      throw new Error(`${label} create bucket failed: HTTP ${res.status}. ${detail}`)
    },

    async deletePrefix(prefix) {
      let count = 0
      let token: string | undefined
      do {
        const page = await listObjects(prefix, token)
        for (const o of page.objects) {
          await deleteObject(o.key)
          count++
        }
        token = page.next
      } while (token)
      return count
    },
  }
}
