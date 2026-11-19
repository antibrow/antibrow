import { ApiError } from '../core/errors'
import { getConfig } from '../core/config'
import { createS3, type S3Store } from '../core/s3'

export function getStore(locals: App.Locals): S3Store {
  const { s3 } = getConfig(locals)
  if (!s3) throw new ApiError(500, 'STORAGE_UNAVAILABLE', 'Object storage is not configured on this server')
  return createS3(s3)
}
