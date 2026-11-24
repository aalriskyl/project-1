import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/errors.ts';
import { requireAuth } from '@/middlewares/auth.ts';
import { getRequiredAdmin, requireAdmin } from '@/middlewares/authorize.ts';
import { publicCache } from '@/middlewares/cache-control.ts';
import {
  ArticleCursorPageSchema,
  ArticleDetailEnvelopeSchema,
  ArticleIdParamSchema,
  ArticleSlugParamSchema,
  CreateArticleBodySchema,
  GetArticleQuerySchema,
  ListArticlesQuerySchema,
  UpdateArticleBodySchema,
} from '@/modules/articles/articles.schema.ts';
import type { ArticlesService } from '@/modules/articles/articles.service.ts';
import type { AppEnv } from '@/types/app.ts';

const listPublishedArticlesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Articles'],
  summary: 'List published SEO articles with cursor pagination and optional tag filter',
  request: {
    query: ListArticlesQuerySchema,
  },
  responses: {
    200: {
      description: 'Cursor-paginated published articles',
      content: { 'application/json': { schema: ArticleCursorPageSchema } },
    },
    422: {
      description: 'Invalid query parameters or cursor',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getPublishedArticleBySlugRoute = createRoute({
  method: 'get',
  path: '/{slug}',
  tags: ['Articles'],
  summary: 'Get a published SEO article by slug (Markdown + SEO meta + related products/articles)',
  request: {
    params: ArticleSlugParamSchema,
    query: GetArticleQuerySchema,
  },
  responses: {
    200: {
      description: 'Published article detail',
      content: { 'application/json': { schema: ArticleDetailEnvelopeSchema } },
    },
    404: {
      description: 'Article not found or unpublished',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Invalid slug or query',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const listAdminArticlesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin - Articles'],
  summary: 'List all non-deleted articles including drafts (admin)',
  security: [{ BearerAuth: [] }],
  request: {
    query: ListArticlesQuerySchema,
  },
  responses: {
    200: {
      description: 'Cursor-paginated admin articles list',
      content: { 'application/json': { schema: ArticleCursorPageSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin privileges required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getAdminArticleByIdRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Admin - Articles'],
  summary: 'Get any article (draft or published) by ID (admin)',
  security: [{ BearerAuth: [] }],
  request: {
    params: ArticleIdParamSchema,
  },
  responses: {
    200: {
      description: 'Article detail',
      content: { 'application/json': { schema: ArticleDetailEnvelopeSchema } },
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
      description: 'Article not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const createArticleRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Admin - Articles'],
  summary: 'Create an SEO article (admin)',
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateArticleBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Article created',
      content: { 'application/json': { schema: ArticleDetailEnvelopeSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin privileges required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Slug already exists',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateArticleRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Admin - Articles'],
  summary: 'Update or publish/unpublish an article (admin)',
  security: [{ BearerAuth: [] }],
  request: {
    params: ArticleIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateArticleBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Article updated',
      content: { 'application/json': { schema: ArticleDetailEnvelopeSchema } },
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
      description: 'Article not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Slug already exists',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteArticleRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Admin - Articles'],
  summary: 'Soft-delete an article (admin)',
  security: [{ BearerAuth: [] }],
  request: {
    params: ArticleIdParamSchema,
  },
  responses: {
    204: {
      description: 'Article soft-deleted',
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
      description: 'Article not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function createPublicArticlesRoutes(articlesService: ArticlesService) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', publicCache({ maxAgeSec: 300, sMaxAgeSec: 3600, staleWhileRevalidateSec: 3600 }));

  return router
    .openapi(listPublishedArticlesRoute, async (c) => {
      const query = c.req.valid('query');
      const page = await articlesService.listPublishedArticles(query);
      return c.json(
        {
          data: [...page.data],
          meta: page.meta,
        },
        200,
      );
    })
    .openapi(getPublishedArticleBySlugRoute, async (c) => {
      const { slug } = c.req.valid('param');
      const query = c.req.valid('query');
      const data = await articlesService.getPublishedArticleBySlug(slug, query);
      return c.json({ data }, 200);
    });
}

export function createAdminArticlesRoutes(
  articlesService: ArticlesService,
  authMiddleware: MiddlewareHandler<AppEnv> = requireAuth,
) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', authMiddleware);
  router.use('*', requireAdmin);

  return router
    .openapi(listAdminArticlesRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const query = c.req.valid('query');
      const page = await articlesService.listAdminArticles(actor, query);
      return c.json(
        {
          data: [...page.data],
          meta: page.meta,
        },
        200,
      );
    })
    .openapi(getAdminArticleByIdRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      const data = await articlesService.getAdminArticleById(actor, id);
      return c.json({ data }, 200);
    })
    .openapi(createArticleRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const body = c.req.valid('json');
      const data = await articlesService.createArticle(actor, body);
      return c.json({ data }, 201);
    })
    .openapi(updateArticleRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const data = await articlesService.updateArticle(actor, id, body);
      return c.json({ data }, 200);
    })
    .openapi(deleteArticleRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      await articlesService.deleteArticle(actor, id);
      return c.body(null, 204);
    });
}
