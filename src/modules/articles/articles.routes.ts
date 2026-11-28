import { OpenAPIHono } from '@hono/zod-openapi';
import { createNamedRoute } from '@/lib/api/openapi.ts';

const createRoute = createNamedRoute('articles');
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/shared/errors.ts';
import { ok, okPage } from '@/lib/api/response.ts';
import { requireAuth } from '@/middlewares/auth/auth.ts';
import { getRequiredAdmin, requireAdmin } from '@/middlewares/auth/authorize.ts';
import { publicCache } from '@/middlewares/cache/cache-control.ts';
import {
  ArticleCursorPageSchema,
  ArticleDetailEnvelopeSchema,
  ArticleIdParamSchema,
  ArticleSlugParamSchema,
  CreateArticleBodySchema,
  GetArticleQuerySchema,
  ListAdminArticlesQuerySchema,
  ListArticlesQuerySchema,
  UpdateArticleBodySchema,
} from '@/modules/articles/articles.schema.ts';
import type { ArticlesService } from '@/modules/articles/articles.service.ts';
import type { AppEnv } from '@/types/app.ts';

const listPublishedArticlesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Articles'],
  summary: 'List Articles',
  description:
    'List published SEO articles with cursor pagination, optional `?tag=`, and `?q=` fuzzy search.',
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
  summary: 'Get Article by Slug',
  description:
    'Fetch a published SEO article by slug including Markdown, SEO metadata, and related products/articles.',
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
  summary: 'Admin: List Articles',
  description:
    'List articles (active, inactive, and drafts) with cursor or optional numbered `?page=` pagination, `?status=active|inactive`, `?tag=`, and `?q=` fuzzy search.',
  security: [{ BearerAuth: [] }],
  request: {
    query: ListAdminArticlesQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated admin articles list',
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
    422: {
      description: 'Invalid pagination or query parameters',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getAdminArticleByIdRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Admin - Articles'],
  summary: 'Admin: Get Article by ID',
  description: 'Fetch any article (draft or published) by ID.',
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
    422: {
      description: 'Invalid UUID path parameter',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const createArticleRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Admin - Articles'],
  summary: 'Admin: Create Article',
  description: 'Create a draft or published SEO article.',
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
  summary: 'Admin: Update Article',
  description: 'Update article content, SEO metadata, or publish/unpublish state.',
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
  summary: 'Admin: Delete Article',
  description: 'Soft-delete an article.',
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
    422: {
      description: 'Invalid UUID path parameter',
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
      return c.json(okPage(page, 'Articles retrieved successfully'), 200);
    })
    .openapi(getPublishedArticleBySlugRoute, async (c) => {
      const { slug } = c.req.valid('param');
      const query = c.req.valid('query');
      const data = await articlesService.getPublishedArticleBySlug(slug, query);
      return c.json(ok(data, 'Article retrieved successfully'), 200);
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
      return c.json(okPage(page, 'Articles retrieved successfully'), 200);
    })
    .openapi(getAdminArticleByIdRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      const data = await articlesService.getAdminArticleById(actor, id);
      return c.json(ok(data, 'Article retrieved successfully'), 200);
    })
    .openapi(createArticleRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const body = c.req.valid('json');
      const data = await articlesService.createArticle(actor, body);
      return c.json(ok(data, 'Article created successfully'), 201);
    })
    .openapi(updateArticleRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const data = await articlesService.updateArticle(actor, id, body);
      return c.json(ok(data, 'Article updated successfully'), 200);
    })
    .openapi(deleteArticleRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      await articlesService.deleteArticle(actor, id);
      return c.body(null, 204);
    });
}
