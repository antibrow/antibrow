import { describe, expect, it } from 'vitest'
import { bucketBase, createS3, normalizeEtag, parseListObjectsXml, profileArchiveKey, profileStateKey } from '../../src/core/s3'

const cfg = { endpoint: 'http://minio:9000/', region: 'us-east-1', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }

describe('s3 core', () => {
  it('keeps the existing key layout', () => {
    expect(profileArchiveKey('p1')).toBe('profile-archive/p1.zip')
    expect(profileStateKey('p1')).toBe('profile-state/p1.json')
  })

  it('normalizes etags', () => {
    expect(normalizeEtag('"abc"')).toBe('abc')
    expect(normalizeEtag('""')).toBeUndefined()
    expect(normalizeEtag(null)).toBeUndefined()
  })

  it('presigns path-style urls against the configured endpoint', async () => {
    const url = new URL(await createS3(cfg).presignGet('profile-archive/p1.zip', 900))
    expect(url.origin + url.pathname).toBe('http://minio:9000/b/profile-archive/p1.zip')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/us-east-1/s3/')
  })

  it('signs presigned urls for the public endpoint and sends server calls to the internal one', async () => {
    const split = { ...cfg, endpoint: 'http://rustfs:9000', publicEndpoint: 'https://s3.example.com/' }
    const url = new URL(await createS3(split).presignPut('profile-archive/p1.zip', 600))
    expect(url.origin + url.pathname).toBe('https://s3.example.com/b/profile-archive/p1.zip')

    const seen: string[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(new Request(input as Request).url)
      return new Response(null, { status: 200 })
    }) as typeof fetch
    try {
      await createS3(split).headObject('k')
      await createS3(split).ensureBucket()
    } finally {
      globalThis.fetch = real
    }
    expect(seen).toEqual(['http://rustfs:9000/b/k', 'http://rustfs:9000/b'])
  })

  it('presigns for the endpoint when no public endpoint is set', async () => {
    const url = new URL(await createS3({ ...cfg, publicEndpoint: undefined }).presignGet('x', 60))
    expect(url.origin).toBe('http://minio:9000')
  })

  it('virtual addressing puts the bucket in the host for presign and server calls', async () => {
    const v = { ...cfg, endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', publicEndpoint: 'https://oss.example.com', addressing: 'virtual' as const }
    const url = new URL(await createS3(v).presignGet('profile-archive/p1.zip', 900))
    expect(url.origin + url.pathname).toBe('https://b.oss.example.com/profile-archive/p1.zip')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('host')

    const seen: string[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(new Request(input as Request).url)
      return new Response(null, { status: 200 })
    }) as typeof fetch
    try {
      await createS3(v).headObject('k')
      await createS3(v).ensureBucket()
      await createS3(v).listObjects('p/')
    } finally {
      globalThis.fetch = real
    }
    expect(seen).toEqual([
      'https://b.oss-cn-hangzhou.aliyuncs.com/k',
      'https://b.oss-cn-hangzhou.aliyuncs.com/',
      'https://b.oss-cn-hangzhou.aliyuncs.com/?list-type=2&prefix=p%2F',
    ])
  })

  it('bucketBase handles both styles and a port', () => {
    expect(bucketBase('http://minio:9000/', 'b')).toBe('http://minio:9000/b')
    expect(bucketBase('http://minio:9000', 'b', 'virtual')).toBe('http://b.minio:9000')
  })

  it('parses a truncated list page', () => {
    const xml = '<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a&amp;b</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>'
    const r = parseListObjectsXml(xml)
    expect(r.objects[0]!.key).toBe('a&b')
    expect(r.next).toBe('t1')
  })
})
