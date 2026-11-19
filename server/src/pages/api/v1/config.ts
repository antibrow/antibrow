import type { APIRoute } from 'astro'
import { getConfig } from '../../../core/config'
import { handleError, jsonResponse } from '../../../core/errors'

export const prerender = false

export const GET: APIRoute = ({ locals, url }) => {
  try {
    const cfg = getConfig(locals)
    return jsonResponse({
      brand: cfg.brand,
      kernelManifestUrl: cfg.kernelManifestUrl,
      appVersionsUrl: `${(cfg.publicUrl || url.origin).replace(/\/+$/, '')}/api/v1/app-versions`,
      recipeRegistryUrl: cfg.recipeRegistryUrl,
      features: {
        cloudSync: true,
        team: false,
        share: false,
        managedProxy: false,
        liveView: false,
        realDevices: false,
        emailLogin: false,
      },
    })
  } catch (error) {
    return handleError(error)
  }
}
