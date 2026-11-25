import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { timeout } from 'hono/timeout';
import { env } from '@/config/env.ts';
import { checkDbReadiness, db } from '@/db/client.ts';
import { defaultOpenApiHook, ErrorResponseSchema, ServiceUnavailableError } from '@/lib/errors.ts';
import { createSuccessEnvelopeSchema, ok } from '@/lib/response.ts';
import { errorHandler, notFoundHandler } from '@/middlewares/error-handler.ts';
import { requestLoggerMiddleware } from '@/middlewares/logger.ts';
import { createRateLimiter, type RateLimitStore } from '@/middlewares/rate-limit.ts';
import { requestIdMiddleware } from '@/middlewares/request-id.ts';
import { redisRateLimitStore } from '@/lib/redis-rate-limit.ts';
import { createArticlesRepository } from '@/modules/articles/articles.repository.ts';
import {
  type ArticlesService,
  createArticlesService,
} from '@/modules/articles/articles.service.ts';
import { createAuthRepository } from '@/modules/auth/auth.repository.ts';
import { type AuthService, createAuthService } from '@/modules/auth/auth.service.ts';
import { createCatalogRepository } from '@/modules/catalog/catalog.repository.ts';
import { type CatalogService, createCatalogService } from '@/modules/catalog/catalog.service.ts';
import { createMediaRepository } from '@/modules/media/media.repository.ts';
import { createMediaService, type MediaService } from '@/modules/media/media.service.ts';
import { createProductsRepository } from '@/modules/products/products.repository.ts';
import {
  createProductsService,
  type ProductsService,
} from '@/modules/products/products.service.ts';
import { createReviewsRepository } from '@/modules/reviews/reviews.repository.ts';
import { createReviewsService, type ReviewsService } from '@/modules/reviews/reviews.service.ts';
import { createUsersRepository } from '@/modules/users/users.repository.ts';
import { createUsersService, type UsersService } from '@/modules/users/users.service.ts';
import type { AppEnv } from '@/types/app.ts';
import { createV1Routes } from '@/v1/routes.ts';

const HealthResponseSchema = createSuccessEnvelopeSchema(
  z.object({
    status: z.enum(['ok', 'ready']).openapi({ example: 'ok' }),
    timestamp: z.iso.datetime().openapi({ example: '2026-11-24T06:00:00.000Z' }),
  }),
  'HealthResponse',
);

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
  readonly catalogService?: CatalogService;
  readonly productsService?: ProductsService;
  readonly reviewsService?: ReviewsService;
  readonly articlesService?: ArticlesService;
  readonly mediaService?: MediaService;
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

  const catalogRepo = createCatalogRepository(db);
  const productsRepo = createProductsRepository(db);

  const authService = deps.authService ?? createAuthService(createAuthRepository(db));
  const usersService = deps.usersService ?? createUsersService(createUsersRepository(db));
  const catalogService = deps.catalogService ?? createCatalogService(catalogRepo);
  const productsService = deps.productsService ?? createProductsService(productsRepo, catalogRepo);
  const reviewsService =
    deps.reviewsService ?? createReviewsService(createReviewsRepository(db), productsRepo);
  const articlesService =
    deps.articlesService ??
    createArticlesService(createArticlesRepository(db), {
      resolveRelatedProducts: (ids) => productsService.resolveRelatedProductCards(ids),
    });
  const mediaService = deps.mediaService ?? createMediaService(createMediaRepository(db));
  const checkReadiness = deps.checkReadiness ?? (() => checkDbReadiness(db));
  const windowMs = deps.rateLimitWindowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const rateLimitStore = deps.rateLimitStore ?? redisRateLimitStore;

  const globalRateLimiter = createRateLimiter({
    windowMs,
    max: deps.globalRateLimitMax ?? env.RATE_LIMIT_MAX,
    keyPrefix: 'global',
    ...(rateLimitStore !== undefined ? { store: rateLimitStore } : {}),
  });

  const authRateLimiter = createRateLimiter({
    windowMs,
    max: deps.authRateLimitMax ?? env.AUTH_RATE_LIMIT_MAX,
    keyPrefix: 'auth',
    ...(rateLimitStore !== undefined ? { store: rateLimitStore } : {}),
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
        'ETag',
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
            success: false as const,
            message: 'Request body exceeds maximum allowed size',
            errorCode: 'PAYLOAD_TOO_LARGE',
            requestId: c.get('requestId'),
          },
          413,
        ),
    }),
  );

  application.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Short-lived HS256 JWT access token issued by /v1/auth/login or /v1/auth/refresh',
  });

  const v1Routes = createV1Routes({
    authService,
    usersService,
    catalogService,
    productsService,
    reviewsService,
    articlesService,
    mediaService,
    globalRateLimiter,
    authRateLimiter,
    ...(deps.authMiddleware !== undefined ? { authMiddleware: deps.authMiddleware } : {}),
  });

  const routes = application
    .openapi(healthRoute, (c) =>
      c.json(
        ok(
          {
            status: 'ok' as const,
            timestamp: new Date().toISOString(),
          },
          'Service is healthy',
        ),
        200,
      ),
    )
    .openapi(readyRoute, async (c) => {
      const ready = await checkReadiness();
      if (!ready) {
        throw new ServiceUnavailableError('Database is unreachable', 'DB_UNAVAILABLE');
      }
      return c.json(
        ok(
          {
            status: 'ready' as const,
            timestamp: new Date().toISOString(),
          },
          'Service is ready',
        ),
        200,
      );
    })
    .route('/v1', v1Routes)
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
