import type { ZodTypeAny, z } from 'zod'
import { BadRequestError, UnauthorizedError } from '../core/errors'
import type { Db } from './db'

export async function parseBody<S extends ZodTypeAny>(request: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new BadRequestError('Invalid JSON body')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? 'Validation failed')
  return parsed.data
}

export function assertAdmin(locals: App.Locals): void {
  if (locals.admin !== true) throw new UnauthorizedError()
}

export function adminDb(locals: App.Locals): Db {
  assertAdmin(locals)
  if (!locals.db) throw new UnauthorizedError()
  return locals.db
}
