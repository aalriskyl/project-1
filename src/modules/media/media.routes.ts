import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/errors.ts';
import { requireAuth } from '@/middlewares/auth.ts';
import { getRequiredAdmin, requireAdmin } from '@/middlewares/authorize.ts';
import {
  CleanupOrphansBodySchema,
  CleanupOrphansEnvelopeSchema,
  RequestUploadUrlBodySchema,
  SignedUploadUrlEnvelopeSchema,
} from '@/modules/media/media.schema.ts';
import type { MediaService } from '@/modules/media/media.service.ts';
import type { AppEnv } from '@/types/app.ts';

const createUploadUrlRoute = createRoute({
  method: 'post',
  path: '/upload-url',
  tags: ['Admin - Media'],
  summary: 'Generate a tracked presigned Supabase Storage upload URL for an image (admin)',
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: RequestUploadUrlBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Presigned upload URL and public asset URL generated',
      content: { 'application/json': { schema: SignedUploadUrlEnvelopeSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin privileges required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Unsupported MIME type or file size out of range',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    503: {
      description: 'Supabase Storage not configured or temporarily unavailable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const cleanupOrphansRoute = createRoute({
  method: 'post',
  path: '/cleanup-orphans',
  tags: ['Admin - Media'],
  summary:
    'Sweep and delete unreferenced Storage uploads older than the grace window (admin / cron)',
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      required: false,
      content: { 'application/json': { schema: CleanupOrphansBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Orphan sweep summary',
      content: { 'application/json': { schema: CleanupOrphansEnvelopeSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin privileges required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    503: {
      description: 'Supabase Storage unavailable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function createAdminMediaRoutes(
  mediaService: MediaService,
  authMiddleware: MiddlewareHandler<AppEnv> = requireAuth,
) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', authMiddleware);
  router.use('*', requireAdmin);

  return router
    .openapi(createUploadUrlRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const body = c.req.valid('json');
      const data = await mediaService.createUploadUrl(actor, body);
      return c.json({ data }, 201);
    })
    .openapi(cleanupOrphansRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const body = c.req.valid('json') ?? { olderThanHours: 24, limit: 100 };
      const data = await mediaService.cleanupOrphans(actor, body);
      return c.json({ data }, 200);
    });
}
