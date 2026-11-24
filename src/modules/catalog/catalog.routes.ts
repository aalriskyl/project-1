import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/errors.ts';
import { requireAuth } from '@/middlewares/auth.ts';
import { getRequiredAdmin, requireAdmin } from '@/middlewares/authorize.ts';
import { publicCache } from '@/middlewares/cache-control.ts';
import {
  CategoryDetailEnvelopeSchema,
  CategoryEnvelopeSchema,
  CategoryIdParamSchema,
  CategoryListEnvelopeSchema,
  CategorySchema,
  CategorySlugParamSchema,
  CreateCategoryBodySchema,
  ListCategoriesQuerySchema,
  SitemapResponseSchema,
  UpdateCategoryBodySchema,
} from '@/modules/catalog/catalog.schema.ts';
import type { CatalogService } from '@/modules/catalog/catalog.service.ts';
import type { AppEnv } from '@/types/app.ts';

const listCategoriesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Catalog'],
  summary: 'List active categories (flat or nested tree)',
  request: {
    query: ListCategoriesQuerySchema,
  },
  responses: {
    200: {
      description: 'Category list or nested hierarchy',
      content: { 'application/json': { schema: CategoryListEnvelopeSchema } },
    },
    422: {
      description: 'Invalid query parameter',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getCategoryBySlugRoute = createRoute({
  method: 'get',
  path: '/{slug}',
  tags: ['Catalog'],
  summary: 'Get category detail, subcategories, and effective spec schema by slug',
  request: {
    params: CategorySlugParamSchema,
  },
  responses: {
    200: {
      description: 'Category detail with merged spec schema',
      content: { 'application/json': { schema: CategoryDetailEnvelopeSchema } },
    },
    404: {
      description: 'Category not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Invalid slug format',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getSitemapRoute = createRoute({
  method: 'get',
  path: '/sitemap',
  tags: ['SEO'],
  summary: 'Get lightweight slug + updatedAt feed for Next.js app/sitemap.ts',
  responses: {
    200: {
      description: 'Sitemap entries across categories, products, and articles',
      content: { 'application/json': { schema: SitemapResponseSchema } },
    },
  },
});

const listAdminCategoriesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin - Catalog'],
  summary: 'List all non-deleted categories including inactive ones (admin)',
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: 'Admin category list',
      content: {
        'application/json': {
          schema: CategoryListEnvelopeSchema,
        },
      },
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

const createCategoryRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Admin - Catalog'],
  summary: 'Create a category or subcategory (admin)',
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateCategoryBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Category created',
      content: { 'application/json': { schema: CategoryEnvelopeSchema } },
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
      description: 'Parent category not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Slug already exists',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed or max depth exceeded',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateCategoryRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Admin - Catalog'],
  summary: 'Update a category or its spec schema (admin)',
  security: [{ BearerAuth: [] }],
  request: {
    params: CategoryIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateCategoryBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Category updated',
      content: { 'application/json': { schema: CategoryEnvelopeSchema } },
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
      description: 'Category not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Slug or hierarchy conflict',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteCategoryRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Admin - Catalog'],
  summary: 'Soft-delete a category (admin)',
  security: [{ BearerAuth: [] }],
  request: {
    params: CategoryIdParamSchema,
  },
  responses: {
    204: {
      description: 'Category soft-deleted',
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
      description: 'Category not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Category still has subcategories',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function createPublicCatalogRoutes(catalogService: CatalogService) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', publicCache({ maxAgeSec: 300, sMaxAgeSec: 3600, staleWhileRevalidateSec: 3600 }));

  return router
    .openapi(listCategoriesRoute, async (c) => {
      const query = c.req.valid('query');
      const data = await catalogService.listPublicCategories(query);
      return c.json({ data: [...data] }, 200);
    })
    .openapi(getCategoryBySlugRoute, async (c) => {
      const { slug } = c.req.valid('param');
      const data = await catalogService.getPublicCategoryBySlug(slug);
      return c.json({ data }, 200);
    });
}

export function createSeoRoutes(catalogService: CatalogService) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', publicCache({ maxAgeSec: 300, sMaxAgeSec: 3600, staleWhileRevalidateSec: 3600 }));

  return router.openapi(getSitemapRoute, async (c) => {
    const data = await catalogService.getSitemap();
    return c.json({ data }, 200);
  });
}

export function createAdminCatalogRoutes(
  catalogService: CatalogService,
  authMiddleware: MiddlewareHandler<AppEnv> = requireAuth,
) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', authMiddleware);
  router.use('*', requireAdmin);

  return router
    .openapi(listAdminCategoriesRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const rows = await catalogService.listAdminCategories(actor);
      return c.json({ data: rows.map((row) => CategorySchema.parse(row)) }, 200);
    })
    .openapi(createCategoryRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const body = c.req.valid('json');
      const data = await catalogService.createCategory(actor, body);
      return c.json({ data }, 201);
    })
    .openapi(updateCategoryRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const data = await catalogService.updateCategory(actor, id, body);
      return c.json({ data }, 200);
    })
    .openapi(deleteCategoryRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      await catalogService.deleteCategory(actor, id);
      return c.body(null, 204);
    });
}
