export type OemConfig = {
  databaseUrl: string
  licensePrivKey: string
  adminPassword?: string
  adminToken?: string
  sessionSecret?: string
  s3: { endpoint: string; publicEndpoint?: string; region: string; addressing?: 'path' | 'virtual'; bucket: string; accessKeyId: string; secretAccessKey: string } | null
  publicUrl: string
  brand: { name: string; logoUrl: string; accent: string; links: { website: string; docs: string; upgrade: string; support: string } }
  kernelManifestUrl: string
  appVersionsKey: string
  recipeRegistryUrl: string
}

type Env = Record<string, string | undefined>

const S3_VARS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const

function required(env: Env, name: string): string {
  const v = env[name]
  if (!v) throw new Error(`Missing required environment variable ${name}`)
  return v
}

function parseAddressing(v: string | undefined): 'path' | 'virtual' {
  if (!v || v === 'path') return 'path'
  if (v === 'virtual') return 'virtual'
  throw new Error('S3_ADDRESSING must be "path" or "virtual"')
}

export function readConfig(env: Env): OemConfig {
  const given = S3_VARS.filter((n) => env[n])
  let s3: OemConfig['s3'] = null
  if (given.length > 0) {
    const missing = S3_VARS.filter((n) => !env[n])
    if (missing.length > 0) throw new Error(`Incomplete S3 configuration, missing: ${missing.join(', ')}`)
    s3 = {
      endpoint: env.S3_ENDPOINT!,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT!,
      region: env.S3_REGION || 'auto',
      addressing: parseAddressing(env.S3_ADDRESSING),
      bucket: env.S3_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    }
  }
  const privKey = required(env, 'FP_LICENSE_PRIVKEY')
  if (/^0+$/.test(privKey)) throw new Error('FP_LICENSE_PRIVKEY must not be an all-zero placeholder')
  const accent = env.OEM_BRAND_ACCENT ?? ''
  if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) throw new Error('OEM_BRAND_ACCENT must be a #RRGGBB color')
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    licensePrivKey: privKey,
    adminPassword: env.OEM_ADMIN_PASSWORD || undefined,
    adminToken: env.OEM_ADMIN_TOKEN || undefined,
    sessionSecret: env.OEM_SESSION_SECRET || undefined,
    s3,
    publicUrl: env.OEM_PUBLIC_URL ?? '',
    brand: {
      name: env.OEM_BRAND_NAME || 'AntiBrow',
      logoUrl: env.OEM_BRAND_LOGO_URL ?? '',
      accent,
      links: {
        website: env.OEM_LINK_WEBSITE ?? '',
        docs: env.OEM_LINK_DOCS ?? '',
        upgrade: env.OEM_LINK_UPGRADE ?? '',
        support: env.OEM_LINK_SUPPORT ?? '',
      },
    },
    kernelManifestUrl: env.KERNEL_MANIFEST_URL || 'https://download.antibrow.com/fp-browser-versions.json',
    appVersionsKey: env.APP_VERSIONS_KEY || 'app-versions.json',
    recipeRegistryUrl: env.RECIPE_REGISTRY_URL ?? '',
  }
}

const cache = new WeakMap<object, OemConfig>()

export function getConfig(locals: App.Locals): OemConfig {
  const hit = cache.get(locals)
  if (hit) return hit
  const env = (locals.runtime?.env as Env | undefined) ?? process.env
  const cfg = readConfig(env)
  cache.set(locals, cfg)
  return cfg
}
