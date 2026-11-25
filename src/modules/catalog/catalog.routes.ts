import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/errors.ts';
import { ok, okPage } from '@/lib/response.ts';
import { requireAuth } from '@/middlewares/auth.ts';
import { getRequiredAdmin, requireAdmin } from '@/middlewares/authorize.ts';
import { publicCache } from '@/middlewares/cache-control.ts';
import {
  CategoryCursorPageSchema,
  CategoryDetailEnvelopeSchema,
  CategoryEnvelopeSchema,
  CategoryIdParamSchema,
  CategoryListEnvelopeSchema,
  CategorySlugParamSchema,
  CreateCategoryBodySchema,
  ListAdminCategoriesQuerySchema,
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
  summary: 'List Categories',
  description:
    'List active categories as a flat list or 2-level nested tree (`?tree=true`) with optional fuzzy search (`?q=`).',
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
  summary: 'Get Category by Slug',
  description:
    'Fetch category detail, child subcategories, and merged `effectiveSpecSchema` by slug.',
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
  summary: 'Get SEO Sitemap Feed',
  description:
    'Return indexable (`noIndex = false`) slugs and `updatedAt` timestamps for Next.js `app/sitemap.ts`.',
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
  summary: 'Admin: List Categories',
  description:
    'List all non-deleted categories (including inactive) with cursor or optional numbered `?page=` pagination and `?q=` fuzzy search.',
  security: [{ BearerAuth: [] }],
  request: {
    query: ListAdminCategoriesQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated admin category list',
      content: {
        'application/json': {
          schema: CategoryCursorPageSchema,
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
    422: {
      description: 'Invalid pagination or query parameters',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const createCategoryRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Admin - Catalog'],
  summary: 'Admin: Create Category',
  description: 'Create a root category or level-2 subcategory.',
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
  summary: 'Admin: Update Category',
  description: 'Update category metadata, SEO fields, hierarchy, or `specSchema`.',
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
  summary: 'Admin: Delete Category',
  description:
    'Soft-delete a category (rejected with 409 if it still has subcategories or products).',
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
      return c.json(ok([...data], 'Categories retrieved successfully'), 200);
    })
    .openapi(getCategoryBySlugRoute, async (c) => {
      const { slug } = c.req.valid('param');
      const data = await catalogService.getPublicCategoryBySlug(slug);
      return c.json(ok(data, 'Category retrieved successfully'), 200);
    });
}

export function createSeoRoutes(catalogService: CatalogService) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', publicCache({ maxAgeSec: 300, sMaxAgeSec: 3600, staleWhileRevalidateSec: 3600 }));

  return router.openapi(getSitemapRoute, async (c) => {
    const data = await catalogService.getSitemap();
    return c.json(ok(data, 'Sitemap feed retrieved successfully'), 200);
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
      const query = c.req.valid('query');
      const page = await catalogService.listAdminCategories(actor, query);
      return c.json(okPage(page, 'Categories retrieved successfully'), 200);
    })
    .openapi(createCategoryRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const body = c.req.valid('json');
      const data = await catalogService.createCategory(actor, body);
      return c.json(ok(data, 'Category created successfully'), 201);
    })
    .openapi(updateCategoryRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const data = await catalogService.updateCategory(actor, id, body);
      return c.json(ok(data, 'Category updated successfully'), 200);
    })
    .openapi(deleteCategoryRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      await catalogService.deleteCategory(actor, id);
      return c.body(null, 204);
    });
}
