/** Version gate: the SDK reports its version, the server decides. */
export const SDK_VERSION = '2.2.0'

const DEFAULT_SERVER = 'https://antibrow.com'

export interface VersionCheckResult {
  status: 'ok' | 'recommended' | 'required'
  current: string
  latest?: string | null
  minSupported?: string | null
  downloadUrl?: string | null
  notes?: string | null
}

/** Fails open: any error resolves to `ok`, so an outage never bricks a client. */
export async function checkClientVersion(options: {
  client: string
  version: string
  server?: string
}): Promise<VersionCheckResult> {
  const { client, version } = options
  const server = options.server || DEFAULT_SERVER

  const url = new URL('/api/v1/version/check', server)
  url.searchParams.set('client', client)
  url.searchParams.set('version', version)

  try {
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
    if (!res.ok) return { status: 'ok', current: version }

    const body = (await res.json()) as Partial<VersionCheckResult>
    const status =
      body.status === 'required' || body.status === 'recommended' ? body.status : 'ok'

    return {
      status,
      current: version,
      latest: body.latest ?? null,
      minSupported: body.minSupported ?? null,
      downloadUrl: body.downloadUrl ?? null,
      notes: body.notes ?? null,
    }
  } catch {

    return { status: 'ok', current: version }
  }
}
