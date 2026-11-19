import { describe, expect, it } from 'vitest'
import { createS3 } from '../../src/core/s3'

const endpoint = process.env.TEST_S3_ENDPOINT
const d = endpoint ? describe : describe.skip

d('s3 against a live S3 compatible server', () => {
  const store = createS3({
    endpoint: endpoint ?? '',
    region: 'us-east-1',
    bucket: `t-${Date.now()}`,
    accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? 'rustfsadmin',
    secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? 'rustfsadmin',
  })

  it('creates the bucket idempotently and round-trips through presigned urls', async () => {
    await store.ensureBucket()
    await store.ensureBucket()
    const key = 'profile-archive/p1.zip'
    expect(await store.headObject(key)).toBeNull()
    const put = await fetch(await store.presignPut(key, 60), { method: 'PUT', body: 'hello' })
    expect(put.ok).toBe(true)
    const get = await fetch(await store.presignGet(key, 60))
    expect(await get.text()).toBe('hello')
    expect((await store.headObject(key))?.etag).toBeTruthy()
    await store.deleteObject(key)
    expect(await store.headObject(key)).toBeNull()
  })
})
