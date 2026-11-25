import { type Hook, z } from '@hono/zod-openapi';
import type { AppEnv } from '@/types/app.ts';

export type ErrorStatusCode = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503;

export interface ValidationIssueDetail {
  readonly field: string;
  readonly message: string;
}

export class AppError extends Error {
  public readonly statusCode: ErrorStatusCode;
  public readonly code: string;
  public readonly details?: readonly ValidationIssueDetail[];

  constructor(
    statusCode: ErrorStatusCode,
    code: string,
    message: string,
    details?: readonly ValidationIssueDetail[],
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = 'Bad request', code: string = 'BAD_REQUEST') {
    super(400, code, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Authentication required', code: string = 'UNAUTHORIZED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message: string = 'You do not have permission to access this resource',
    code: string = 'FORBIDDEN',
  ) {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found', code: string = 'RESOURCE_NOT_FOUND') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Resource conflict', code: string = 'CONFLICT') {
    super(409, code, message);
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string = 'Request validation failed',
    details: readonly ValidationIssueDetail[] = [],
  ) {
    super(422, 'VALIDATION_ERROR', message, details);
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfterSec: number;

  constructor(retryAfterSec: number, message: string = 'Too many requests') {
    super(429, 'RATE_LIMIT_EXCEEDED', message);
    this.retryAfterSec = retryAfterSec;
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(
    message: string = 'Service temporarily unavailable',
    code: string = 'SERVICE_UNAVAILABLE',
  ) {
    super(503, code, message);
  }
}

export const ValidationIssueSchema = z
  .object({
    field: z.string().openapi({ example: 'email' }),
    message: z.string().openapi({ example: 'Invalid email address' }),
  })
  .openapi('ValidationIssue');

export const ErrorResponseSchema = z
  .object({
    success: z.literal(false),
    message: z.string().openapi({ example: 'Request validation failed' }),
    errorCode: z.string().openapi({ example: 'VALIDATION_ERROR' }),
    requestId: z.string().optional().openapi({ example: '01936c8e-7f2a-7000-8000-000000000001' }),
    details: z.array(ValidationIssueSchema).optional(),
  })
  .openapi('ErrorResponse');

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const defaultOpenApiHook: Hook<unknown, AppEnv, string, Response | undefined> = (
  result,
  c,
) => {
  if (!result.success) {
    const details: ValidationIssueDetail[] = result.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.map(String).join('.') : result.target,
      message: issue.message,
    }));

    return c.json(
      {
        success: false as const,
        message: 'Request validation failed',
        errorCode: 'VALIDATION_ERROR',
        requestId: c.get('requestId'),
        details,
      },
      422,
    );
  }
  return undefined;
};
