import type { APIRoute } from 'astro'

export const prerender = false

export const POST: APIRoute = () => new Response(null, { status: 204 })
