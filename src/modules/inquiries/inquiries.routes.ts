import { OpenAPIHono, z } from '@hono/zod-openapi';
import { createNamedRoute } from '@/lib/api/openapi.ts';

const createRoute = createNamedRoute('inquiries');
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/shared/errors.ts';
import { ok, okPage } from '@/lib/api/response.ts';
import { getRequiredAdmin, requireAdmin } from '@/middlewares/auth/authorize.ts';
import type { MiddlewareHandler } from 'hono';
import {
  CreateInquiryBodySchema,
  CreateInquiryHeadersSchema,
  InquiryDetailEnvelopeSchema,
  InquiryEnvelopeSchema,
  InquiryCursorPageSchema,
  ListAdminInquiriesQuerySchema,
  UpdateInquiryStatusBodySchema,
} from '@/modules/inquiries/inquiries.schema.ts';
import type { InquiriesService } from '@/modules/inquiries/inquiries.service.ts';
import type { AppEnv } from '@/types/app.ts';

const createInquiryRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Inquiries'],
  summary: 'Submit a quote / pre-order request',
  description:
    'Public RFQ submission. Requires an Idempotency-Key header; retries with the same key return the original receipt.',
  request: {
    headers: CreateInquiryHeadersSchema,
    body: { required: true, content: { 'application/json': { schema: CreateInquiryBodySchema } } },
  },
  responses: {
    201: {
      description: 'Inquiry stored',
      content: { 'application/json': { schema: InquiryEnvelopeSchema } },
    },
    400: {
      description: 'Malformed request payload',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Referenced product is not active',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Idempotency-Key reused with a different request body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: {
      description: 'Rate limit exceeded',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const listAdminInquiriesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin - Inquiries'],
  summary: 'Admin: List Inquiries',
  security: [{ BearerAuth: [] }],
  request: { query: ListAdminInquiriesQuerySchema },
  responses: {
    200: {
      description: 'Paginated inquiry queue',
      content: { 'application/json': { schema: InquiryCursorPageSchema } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin role required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const InquiryIdParamSchema = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

const updateInquiryStatusRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Admin - Inquiries'],
  summary: 'Admin: Update Inquiry Status',
  security: [{ BearerAuth: [] }],
  request: {
    params: InquiryIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateInquiryStatusBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated inquiry',
      content: {
        'application/json': { schema: InquiryDetailEnvelopeSchema },
      },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin role required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Inquiry not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function createPublicInquiriesRoutes(
  inquiriesService: InquiriesService,
  rateLimiter: MiddlewareHandler<AppEnv>,
) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });
  router.use('*', rateLimiter);
  return router.openapi(createInquiryRoute, async (c) => {
    const headers = c.req.valid('header');
    const data = await inquiriesService.submit(c.req.valid('json'), headers['Idempotency-Key']);
    return c.json(ok(data, 'Inquiry submitted successfully'), 201);
  });
}

export function createAdminInquiriesRoutes(
  inquiriesService: InquiriesService,
  authMiddleware: MiddlewareHandler<AppEnv> = requireAdmin,
) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });
  router.use('*', authMiddleware);
  router.use('*', requireAdmin);

  return router
    .openapi(listAdminInquiriesRoute, async (c) => {
      getRequiredAdmin(c);
      const page = await inquiriesService.listAdmin(c.req.valid('query'));
      return c.json(okPage(page, 'Inquiries retrieved successfully'), 200);
    })
    .openapi(updateInquiryStatusRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const data = await inquiriesService.updateStatus(
        actor,
        c.req.valid('param').id,
        c.req.valid('json'),
      );
      return c.json(ok(data, 'Inquiry status updated'), 200);
    });
}
