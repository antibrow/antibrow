import type { APIRoute } from 'astro'

export const prerender = false

interface CfProperties {
  country?: string
  city?: string
  timezone?: string
}

function countryName(code: string | null): string | null {
  if (!code) return null
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code)
    return name && name !== code ? name : null
  } catch {
    return null
  }
}

// `country` stays a two-letter code: published SDKs read that key as the code.
export const GET: APIRoute = ({ request }) => {
  const cf = (request as unknown as { cf?: CfProperties }).cf
  const code = cf?.country || null
  return new Response(
    JSON.stringify({
      ip: request.headers.get('CF-Connecting-IP') || null,
      country: code,
      countryCode: code,
      countryName: countryName(code),
      city: cf?.city || null,
      timezone: cf?.timezone || null,
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  )
}
