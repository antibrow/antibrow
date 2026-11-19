import { createS3 } from '../core/s3'
import type { OemConfig } from '../core/config'

/** Raw policy file from S3; an unreadable or absent file reads as empty so the version gate stays open. */
export async function readAppVersions(cfg: OemConfig): Promise<Record<string, unknown>> {
  if (!cfg.s3) return {}
  try {
    const text = await createS3(cfg.s3).getObjectText(cfg.appVersionsKey)
    if (!text) return {}
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch (error) {
    console.error(`Failed to read ${cfg.appVersionsKey}:`, error)
    return {}
  }
}
