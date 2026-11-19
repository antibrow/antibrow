import { describe, expect, it } from 'vitest'
import { createBucketUrl } from '../scripts/ensure-bucket.mjs'

describe('ensure-bucket url', () => {
  it('path style appends the bucket', () => {
    expect(createBucketUrl('http://minio:9000/', 'b')).toBe('http://minio:9000/b')
  })
  it('virtual style puts the bucket in the host and creates on /', () => {
    expect(createBucketUrl('https://oss-cn-hangzhou.aliyuncs.com', 'b', 'virtual')).toBe('https://b.oss-cn-hangzhou.aliyuncs.com/')
  })
})
