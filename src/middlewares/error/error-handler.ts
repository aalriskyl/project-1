import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AppError, type ErrorStatusCode, RateLimitError } from '@/lib/shared/errors.ts';
import { logger as rootLogger } from '@/lib/logging/logger.ts';
import type { AppEnv } from '@/types/app.ts';

function mapHttpException(err: HTTPException): {
  readonly statusCode: ErrorStatusCode;
  readonly code: string;
  readonly message: string;
} {
  switch (err.status) {
    case 400:
      return { statusCode: 400, code: 'BAD_REQUEST', message: 'Malformed request payload' };
    case 401:
      return { statusCode: 401, code: 'UNAUTHORIZED', message: 'Authentication required' };
    case 403:
      return { statusCode: 403, code: 'FORBIDDEN', message: 'Forbidden' };
    case 404:
      return { statusCode: 404, code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' };
    case 413:
      return {
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds maximum allowed size',
      };
    // @hono/zod-openapi rejects a JSON route with a non-JSON Content-Type via HTTPException(415).
    // Fold it into the documented 400 contract instead of surfacing it as a server error.
    case 415:
      return {
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'Unsupported media type; expected application/json',
      };
    case 408:
    case 504:
      return { statusCode: 503, code: 'REQUEST_TIMEOUT', message: 'Request timed out' };
    default:
      return {
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
      };
  }
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');
  const reqLogger = c.get('logger') ?? rootLogger;

  if (err instanceof AppError) {
    if (err instanceof RateLimitError) {
      c.header('Retry-After', String(err.retryAfterSec));
    }

    if (err.statusCode >= 500) {
      reqLogger.error(
        {
          err,
          errorCode: err.code,
          statusCode: err.statusCode,
          path: c.req.path,
          method: c.req.method,
        },
        'application error',
      );
    }

    return c.json(
      {
        success: false as const,
        message: err.message,
        errorCode: err.code,
        requestId,
        ...(err.details !== undefined ? { details: [...err.details] } : {}),
      },
      err.statusCode,
    );
  }

  if (err instanceof HTTPException) {
    const mapped = mapHttpException(err);
    if (mapped.statusCode >= 500) {
      reqLogger.error({ err, path: c.req.path, method: c.req.method }, 'http exception');
    }
    return c.json(
      {
        success: false as const,
        message: mapped.message,
        errorCode: mapped.code,
        requestId,
      },
      mapped.statusCode,
    );
  }

  // Never leak stack traces, SQL errors, or internal state to clients.
  reqLogger.error({ err, path: c.req.path, method: c.req.method }, 'unhandled exception');

  return c.json(
    {
      success: false as const,
      message: 'An unexpected error occurred',
      errorCode: 'INTERNAL_SERVER_ERROR',
      requestId,
    },
    500,
  );
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  const requestId = c.get('requestId');
  return c.json(
    {
      success: false as const,
      message: 'The requested endpoint does not exist',
      errorCode: 'ROUTE_NOT_FOUND',
      requestId,
    },
    404,
  );
};
