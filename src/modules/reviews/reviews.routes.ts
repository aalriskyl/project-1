import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/errors.ts';
import { ok, okPage } from '@/lib/response.ts';
import { getRequiredUser, requireAuth } from '@/middlewares/auth.ts';
import { getRequiredAdmin, requireAdmin } from '@/middlewares/authorize.ts';
import { publicCache } from '@/middlewares/cache-control.ts';
import { ProductIdParamSchema } from '@/modules/products/products.schema.ts';
import {
  CreateProductReviewBodySchema,
  ListAdminReviewsQuerySchema,
  ListProductReviewsQuerySchema,
  ModerateReviewBodySchema,
  ProductReviewCursorPageSchema,
  ProductReviewEnvelopeSchema,
  ReviewIdParamSchema,
} from '@/modules/reviews/reviews.schema.ts';
import type { ReviewsService } from '@/modules/reviews/reviews.service.ts';
import type { AppEnv } from '@/types/app.ts';

const listProductReviewsRoute = createRoute({
  method: 'get',
  path: '/{id}/reviews',
  tags: ['Reviews'],
  summary: 'List Product Reviews',
  description: 'List published customer reviews for a product with cursor pagination.',
  request: {
    params: ProductIdParamSchema,
    query: ListProductReviewsQuerySchema,
  },
  responses: {
    200: {
      description: 'Cursor-paginated product reviews',
      content: { 'application/json': { schema: ProductReviewCursorPageSchema } },
    },
    404: {
      description: 'Product not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function createProductReviewsRoutes(
  reviewsService: ReviewsService,
  authMiddleware: MiddlewareHandler<AppEnv> = requireAuth,
) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use(
    '/:id/reviews',
    publicCache({ maxAgeSec: 60, sMaxAgeSec: 120, staleWhileRevalidateSec: 300 }),
  );

  const createReviewRoute = createRoute({
    method: 'post',
    path: '/{id}/reviews',
    tags: ['Reviews'],
    summary: 'Create Product Review',
    description:
      'Submit a customer review (1–5 stars) for a product and recalculate its rating rollup.',
    security: [{ BearerAuth: [] }],
    middleware: [authMiddleware] as const,
    request: {
      params: ProductIdParamSchema,
      body: {
        required: true,
        content: { 'application/json': { schema: CreateProductReviewBodySchema } },
      },
    },
    responses: {
      201: {
        description: 'Review created',
        content: { 'application/json': { schema: ProductReviewEnvelopeSchema } },
      },
      401: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      404: {
        description: 'Product not found',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      409: {
        description: 'Duplicate review for this product',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      422: {
        description: 'Validation failed',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  });

  return router
    .openapi(listProductReviewsRoute, async (c) => {
      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const page = await reviewsService.listProductReviews(id, query);
      return c.json(okPage(page, 'Product reviews retrieved successfully'), 200);
    })
    .openapi(createReviewRoute, async (c) => {
      const actor = getRequiredUser(c);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const data = await reviewsService.createProductReview(actor, id, body);
      return c.json(ok(data, 'Product review submitted successfully'), 201);
    });
}

const listAdminReviewsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin - Reviews'],
  summary: 'Admin: List Reviews',
  description:
    'List all product reviews (published and unpublished) with cursor or optional numbered `?page=` pagination and filters.',
  security: [{ BearerAuth: [] }],
  request: {
    query: ListAdminReviewsQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated product reviews moderation list',
      content: { 'application/json': { schema: ProductReviewCursorPageSchema } },
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
      description: 'Invalid filter or pagination parameters',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const moderateReviewRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Admin - Reviews'],
  summary: 'Admin: Moderate Review',
  description: 'Publish or unpublish a product review and recalculate the product rating.',
  security: [{ BearerAuth: [] }],
  request: {
    params: ReviewIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: ModerateReviewBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Review updated',
      content: { 'application/json': { schema: ProductReviewEnvelopeSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin privileges required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Review not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteReviewRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Admin - Reviews'],
  summary: 'Admin: Delete Review',
  description: 'Delete a product review and recalculate the product rating.',
  security: [{ BearerAuth: [] }],
  request: {
    params: ReviewIdParamSchema,
  },
  responses: {
    204: {
      description: 'Review deleted',
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin privileges required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Review not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function createAdminReviewsRoutes(
  reviewsService: ReviewsService,
  authMiddleware: MiddlewareHandler<AppEnv> = requireAuth,
) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', authMiddleware);
  router.use('*', requireAdmin);

  return router
    .openapi(listAdminReviewsRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const query = c.req.valid('query');
      const page = await reviewsService.listAdminReviews(actor, query);
      return c.json(okPage(page, 'Product reviews retrieved successfully'), 200);
    })
    .openapi(moderateReviewRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const data = await reviewsService.moderateReview(actor, id, body);
      return c.json(ok(data, 'Product review updated successfully'), 200);
    })
    .openapi(deleteReviewRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      await reviewsService.deleteReview(actor, id);
      return c.body(null, 204);
    });
}
