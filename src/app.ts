import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { timeout } from 'hono/timeout';
import { env } from '@/config/env.ts';
import { checkDbReadiness, db } from '@/db/client.ts';
import { defaultOpenApiHook, ErrorResponseSchema, ServiceUnavailableError } from '@/lib/errors.ts';
import { requireAuth } from '@/middlewares/auth.ts';
import { errorHandler, notFoundHandler } from '@/middlewares/error-handler.ts';
import { requestLoggerMiddleware } from '@/middlewares/logger.ts';
import { createRateLimiter, type RateLimitStore } from '@/middlewares/rate-limit.ts';
import { requestIdMiddleware } from '@/middlewares/request-id.ts';
import { createAuthRepository } from '@/modules/auth/auth.repository.ts';
import { createAuthRoutes } from '@/modules/auth/auth.routes.ts';
import { type AuthService, createAuthService } from '@/modules/auth/auth.service.ts';
import { createUsersRepository } from '@/modules/users/users.repository.ts';
import { createUsersRoutes } from '@/modules/users/users.routes.ts';
import { createUsersService, type UsersService } from '@/modules/users/users.service.ts';
import type { AppEnv } from '@/types/app.ts';

const HealthResponseSchema = z
  .object({
    status: z.enum(['ok', 'ready']).openapi({ example: 'ok' }),
    timestamp: z.iso.datetime().openapi({ example: '2026-11-24T06:00:00.000Z' }),
  })
  .openapi('HealthResponse');

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['System'],
  summary: 'Liveness probe',
  responses: {
    200: {
      description: 'Process is alive',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
  },
});

const readyRoute = createRoute({
  method: 'get',
  path: '/ready',
  tags: ['System'],
  summary: 'Readiness probe (verifies database connectivity)',
  responses: {
    200: {
      description: 'Service and database are ready',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
    503: {
      description: 'Database is unreachable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export interface AppDependencies {
  readonly authService?: AuthService;
  readonly usersService?: UsersService;
  readonly authMiddleware?: MiddlewareHandler<AppEnv>;
  readonly checkReadiness?: () => Promise<boolean>;
  readonly rateLimitStore?: RateLimitStore;
  readonly globalRateLimitMax?: number;
  readonly authRateLimitMax?: number;
  readonly rateLimitWindowMs?: number;
  readonly maxBodyBytes?: number;
}

export function createApp(deps: AppDependencies = {}) {
  const application = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  const authService = deps.authService ?? createAuthService(createAuthRepository(db));
  const usersService = deps.usersService ?? createUsersService(createUsersRepository(db));
  const checkReadiness = deps.checkReadiness ?? (() => checkDbReadiness(db));
  const windowMs = deps.rateLimitWindowMs ?? env.RATE_LIMIT_WINDOW_MS;

  const globalRateLimiter = createRateLimiter({
    windowMs,
    max: deps.globalRateLimitMax ?? env.RATE_LIMIT_MAX,
    keyPrefix: 'global',
    ...(deps.rateLimitStore !== undefined ? { store: deps.rateLimitStore } : {}),
  });

  const authRateLimiter = createRateLimiter({
    windowMs,
    max: deps.authRateLimitMax ?? env.AUTH_RATE_LIMIT_MAX,
    keyPrefix: 'auth',
    ...(deps.rateLimitStore !== undefined ? { store: deps.rateLimitStore } : {}),
  });

  application.use('*', requestIdMiddleware);
  application.use('*', requestLoggerMiddleware);
  application.use('*', secureHeaders());
  application.use(
    '*',
    cors({
      origin: (origin) => (env.CORS_ORIGINS.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
      exposeHeaders: [
        'X-Request-Id',
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
      ],
      credentials: true,
      maxAge: 600,
    }),
  );
  application.use('*', timeout(env.REQUEST_TIMEOUT_MS));
  application.use(
    '*',
    bodyLimit({
      maxSize: deps.maxBodyBytes ?? env.MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: 'Request body exceeds maximum allowed size',
              requestId: c.get('requestId'),
            },
          },
          413,
        ),
    }),
  );

  application.use('/v1/*', globalRateLimiter);

  application.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Short-lived HS256 JWT access token issued by /v1/auth/login or /v1/auth/refresh',
  });

  const routes = application
    .openapi(healthRoute, (c) =>
      c.json(
        {
          status: 'ok' as const,
          timestamp: new Date().toISOString(),
        },
        200,
      ),
    )
    .openapi(readyRoute, async (c) => {
      const ready = await checkReadiness();
      if (!ready) {
        throw new ServiceUnavailableError('Database is unreachable', 'DB_UNAVAILABLE');
      }
      return c.json(
        {
          status: 'ready' as const,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    })
    .route('/v1/auth', createAuthRoutes(authService, authRateLimiter))
    .route('/v1/users', createUsersRoutes(usersService, deps.authMiddleware ?? requireAuth))
    .doc31('/v1/openapi.json', {
      openapi: '3.1.0',
      info: {
        title: 'Project 1 API',
        version: '1.0.0',
        description: 'Versioned REST API built with Bun, Hono, Zod OpenAPI, and Drizzle ORM.',
      },
    });

  application.onError(errorHandler);
  application.notFound(notFoundHandler);

  return routes;
}

export const app = createApp();
export type AppType = typeof app;
