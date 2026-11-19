import type { APIRoute } from 'astro'
import { getConfig } from '../../../../core/config'
import { handleError, jsonResponse, UnauthorizedError } from '../../../../core/errors'
import { mintLicenseToken } from '../../../../core/license'

export const prerender = false

export const POST: APIRoute = async ({ locals }) => {
  try {
    const { entitlement } = locals
    if (!entitlement) throw new UnauthorizedError()
    const { token, exp } = mintLicenseToken(getConfig(locals).licensePrivKey, entitlement.mi)
    return jsonResponse({ token, exp, mi: entitlement.mi, sync: entitlement.sync })
  } catch (error) {
    return handleError(error)
  }
}
