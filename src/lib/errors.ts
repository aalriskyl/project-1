import { type Hook, z } from '@hono/zod-openapi';
import type { AppEnv } from '@/types/app.ts';

export type ErrorStatusCode = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503;

/** Every machine-readable error code the API can emit. Also published in OpenAPI. */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RESOURCE_NOT_FOUND',
  'CONFLICT',
  'VALIDATION_ERROR',
  'RATE_LIMIT_EXCEEDED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_SERVER_ERROR',
  'ROUTE_NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'REQUEST_TIMEOUT',
  'ADMIN_REQUIRED',
  'INVALID_GOOGLE_TOKEN',
  'INVALID_TOKEN',
  'MISSING_TOKEN',
  'ACCOUNT_INACTIVE',
  'TOKEN_REVOKED',
  'OAUTH_NOT_CONFIGURED',
  'UNVERIFIED_GOOGLE_EMAIL',
  'INVALID_CREDENTIALS',
  'GOOGLE_LINK_REQUIRED',
  'GOOGLE_ACCOUNT_MISMATCH',
  'MAIL_NOT_CONFIGURED',
  'INVALID_RESET_TOKEN',
  'PASSWORD_NOT_SET',
  'INVALID_REFRESH_TOKEN',
  'REFRESH_TOKEN_EXPIRED',
  'REFRESH_TOKEN_REUSED',
  'EMAIL_ALREADY_EXISTS',
  'GOOGLE_SUB_MISMATCH',
  'GOOGLE_ALREADY_LINKED',
  'LAST_ADMIN_REQUIRED',
  'USER_NOT_FOUND',
  'USER_FORBIDDEN',
  'CANNOT_DEACTIVATE_SELF',
  'CANNOT_DEMOTE_SELF',
  'SLUG_ALREADY_EXISTS',
  'SKU_ALREADY_EXISTS',
  'PARENT_CATEGORY_NOT_FOUND',
  'CATEGORY_DEPTH_CONFLICT',
  'CATEGORY_NOT_FOUND',
  'CATEGORY_HAS_CHILDREN',
  'CATEGORY_HAS_PRODUCTS',
  'PRODUCT_NOT_FOUND',
  'COMPARE_PRODUCTS_NOT_FOUND',
  'SPAREPART_PRODUCT_NOT_FOUND',
  'ARTICLE_NOT_FOUND',
  'REVIEW_NOT_FOUND',
  'REVIEW_ALREADY_EXISTS',
  'MEDIA_NOT_FOUND',
  'MEDIA_DELETING',
  'MEDIA_CLEANUP_DISABLED',
  'MEDIA_NOT_VERIFIED',
  'MEDIA_UPLOAD_MISSING',
  'MEDIA_UPLOAD_MISMATCH',
  'STORAGE_UNAVAILABLE',
  'STORAGE_NOT_CONFIGURED',
  'STORAGE_SIGN_FAILED',
  'STORAGE_DELETE_FAILED',
  'STORAGE_BUCKET_UNSAFE',
  'FILE_TOO_LARGE',
  'MAIL_DELIVERY_FAILED',
  'RATE_LIMIT_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ValidationIssueDetail {
  readonly field: string;
  readonly message: string;
}

export class AppError extends Error {
  public readonly statusCode: ErrorStatusCode;
  public readonly code: ErrorCode;
  public readonly details?: readonly ValidationIssueDetail[];

  constructor(
    statusCode: ErrorStatusCode,
    code: ErrorCode,
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
  constructor(message: string = 'Bad request', code: ErrorCode = 'BAD_REQUEST') {
    super(400, code, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Authentication required', code: ErrorCode = 'UNAUTHORIZED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message: string = 'You do not have permission to access this resource',
    code: ErrorCode = 'FORBIDDEN',
  ) {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found', code: ErrorCode = 'RESOURCE_NOT_FOUND') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Resource conflict', code: ErrorCode = 'CONFLICT') {
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
    code: ErrorCode = 'SERVICE_UNAVAILABLE',
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
    errorCode: z.enum(ERROR_CODES).openapi({ example: 'VALIDATION_ERROR' }),
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
