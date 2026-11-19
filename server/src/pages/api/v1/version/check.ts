import type { APIRoute } from 'astro'
import { getConfig } from '../../../../core/config'
import { BadRequestError, handleError, jsonResponse } from '../../../../core/errors'
import { readAppVersions } from '../../../../lib/app-versions'
import { evaluateVersion } from '../../../../lib/version'

export const prerender = false

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const client = url.searchParams.get('client')
    const version = url.searchParams.get('version')
    if (!client) throw new BadRequestError('Missing "client" query parameter')
    if (!version) throw new BadRequestError('Missing "version" query parameter')

    const file = await readAppVersions(getConfig(locals))
    const clients = file.clients
    const policy =
      clients && typeof clients === 'object' && !Array.isArray(clients)
        ? (clients as Record<string, Record<string, unknown>>)[client]
        : undefined

    if (!policy || typeof policy.latest !== 'string' || typeof policy.minSupported !== 'string') {
      return jsonResponse({ status: 'ok', current: version, latest: null })
    }

    return jsonResponse({
      status: evaluateVersion(version, { latest: policy.latest, minSupported: policy.minSupported }),
      current: version,
      latest: policy.latest,
      minSupported: policy.minSupported,
      downloadUrl: typeof policy.downloadUrl === 'string' ? policy.downloadUrl : null,
      notes: typeof policy.notes === 'string' ? policy.notes : null,
    })
  } catch (error) {
    return handleError(error)
  }
}
