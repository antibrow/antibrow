// Creates the S3 bucket at container start when S3_CREATE_BUCKET=1. Retries
// because the storage container may still be booting.
import { AwsClient } from 'aws4fetch'
import { fileURLToPath } from 'node:url'

/** CreateBucket URL: `endpoint/bucket` (path) or `bucket.host/` (virtual, as Aliyun OSS requires). */
export function createBucketUrl(endpoint, bucket, addressing = 'path') {
  const e = endpoint.replace(/\/+$/, '')
  if (addressing !== 'virtual') return `${e}/${bucket}`
  const u = new URL(e)
  return `${u.protocol}//${bucket}.${u.host}${u.pathname.replace(/\/+$/, '')}/`
}

async function main() {

  if (process.env.S3_CREATE_BUCKET !== '1') process.exit(0)

  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION, S3_ADDRESSING } = process.env
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    console.error('S3_CREATE_BUCKET=1 needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY')
    process.exit(1)
  }

  const client = new AwsClient({ accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY })
  if (S3_ADDRESSING && S3_ADDRESSING !== 'path' && S3_ADDRESSING !== 'virtual') {
    console.error('S3_ADDRESSING must be "path" or "virtual"')
    process.exit(1)
  }
  const url = createBucketUrl(S3_ENDPOINT, S3_BUCKET, S3_ADDRESSING)

  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const res = await client.fetch(url, { method: 'PUT', aws: { service: 's3', region: S3_REGION || 'auto' } })
      const detail = await res.text().catch(() => '')
      if (res.ok || (res.status === 409 && /BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(detail))) {
        console.log(`bucket ${S3_BUCKET} ready`)
        process.exit(0)
      }
      console.error(`create bucket: HTTP ${res.status} ${detail}`)
    } catch (err) {
      console.error(`create bucket: ${err instanceof Error ? err.message : err}`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.error('could not create bucket, giving up')
  process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
