import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/errors.ts';
import { ok } from '@/lib/response.ts';
import { requireAuth } from '@/middlewares/auth.ts';
import { getRequiredAdmin, requireAdmin } from '@/middlewares/authorize.ts';
import {
  CleanupOrphansBodySchema,
  CleanupOrphansEnvelopeSchema,
  CompleteUploadParamSchema,
  CompletedUploadEnvelopeSchema,
  RequestUploadUrlBodySchema,
  SignedUploadUrlEnvelopeSchema,
} from '@/modules/media/media.schema.ts';
import type { MediaService } from '@/modules/media/media.service.ts';
import type { AppEnv } from '@/types/app.ts';

const createUploadUrlRoute = createRoute({
  method: 'post',
  path: '/upload-url',
  tags: ['Admin - Media'],
  summary: 'Admin: Create Upload URL',
  description: 'Generate a tracked presigned Supabase Storage upload URL for an image.',
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

const completeUploadRoute = createRoute({
  method: 'post',
  path: '/{id}/complete',
  tags: ['Admin - Media'],
  summary: 'Verify stored image size, MIME and signature before attachment (idempotent)',
  security: [{ BearerAuth: [] }],
  request: { params: CompleteUploadParamSchema },
  responses: {
    200: {
      description: 'Verified upload',
      content: { 'application/json': { schema: CompletedUploadEnvelopeSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Upload not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Upload missing, invalid, or being deleted',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Invalid upload ID',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    503: {
      description: 'Storage unavailable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const cleanupOrphansRoute = createRoute({
  method: 'post',
  path: '/cleanup-orphans',
  tags: ['Admin - Media'],
  summary: 'Admin: Cleanup Orphaned Media',
  description: 'Sweep and delete unreferenced Storage uploads older than the grace window.',
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
    .openapi(completeUploadRoute, async (c) => {
      const data = await mediaService.completeUpload(getRequiredAdmin(c), c.req.valid('param').id);
      return c.json(ok(data, 'Media upload verified'), 200);
    })
    .openapi(createUploadUrlRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const body = c.req.valid('json');
      const data = await mediaService.createUploadUrl(actor, body);
      return c.json(ok(data, 'Presigned upload URL generated successfully'), 201);
    })
    .openapi(cleanupOrphansRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const body = c.req.valid('json') ?? { olderThanHours: 24, limit: 100 };
      const data = await mediaService.cleanupOrphans(actor, body);
      return c.json(ok(data, 'Orphaned media cleanup completed'), 200);
    });
}
