export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
      },
    }
  }

  toResponse(): Response {
    return new Response(JSON.stringify(this.toJSON()), {
      status: this.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string = 'Bad request') {
    super(400, 'BAD_REQUEST', message)
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message: string = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message)
  }
}

export class ForbiddenError extends ApiError {
  constructor(message: string = 'Forbidden') {
    super(403, 'FORBIDDEN', message)
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string = 'Not found') {
    super(404, 'NOT_FOUND', message)
  }
}

export class ConflictError extends ApiError {
  constructor(message: string = 'Conflict', code: string = 'CONFLICT') {
    super(409, code, message)
  }
}

export class QuotaExceededError extends ApiError {
  constructor(message: string = 'Monthly quota exceeded') {
    super(429, 'QUOTA_EXCEEDED', message)
  }
}

export class InternalError extends ApiError {
  constructor(message: string = 'Internal server error') {
    super(500, 'INTERNAL_ERROR', message)
  }
}

export function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function handleError(error: unknown): Response {
  if (error instanceof ApiError) {
    return error.toResponse()
  }

  console.error('Unhandled error:', error)
  return new InternalError().toResponse()
}
