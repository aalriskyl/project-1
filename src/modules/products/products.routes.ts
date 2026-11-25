import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/errors.ts';
import { CursorPaginationQuerySchema } from '@/lib/pagination.ts';
import { ok, okPage } from '@/lib/response.ts';
import { requireAuth } from '@/middlewares/auth.ts';
import { getRequiredAdmin, requireAdmin } from '@/middlewares/authorize.ts';
import { publicCache } from '@/middlewares/cache-control.ts';
import {
  CompareProductsEnvelopeSchema,
  CompareProductsQuerySchema,
  CreateProductBodySchema,
  GetProductDetailQuerySchema,
  ListAdminProductsQuerySchema,
  ListProductsQuerySchema,
  ProductCardListEnvelopeSchema,
  ProductCursorPageSchema,
  ProductDetailEnvelopeSchema,
  ProductIdParamSchema,
  ProductSlugParamSchema,
  ProductSparepartsListEnvelopeSchema,
  RecommendationsQuerySchema,
  ReplaceSparepartsBodySchema,
  SparepartCursorPageSchema,
  UpdateProductBodySchema,
} from '@/modules/products/products.schema.ts';
import type { ProductsService } from '@/modules/products/products.service.ts';
import type { AppEnv } from '@/types/app.ts';

const listProductsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Products'],
  summary: 'List Products',
  description:
    'List and search active products with cursor pagination, category/brand/price filters, and `?q=` fuzzy search.',
  request: {
    query: ListProductsQuerySchema,
  },
  responses: {
    200: {
      description: 'Cursor-paginated product cards',
      content: { 'application/json': { schema: ProductCursorPageSchema } },
    },
    422: {
      description: 'Invalid filter or pagination parameters',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const compareProductsRoute = createRoute({
  method: 'get',
  path: '/compare',
  tags: ['Products'],
  summary: 'Compare Products',
  description:
    'Compare 2 to 4 active products in a single batched query with aligned `specSchema` rows.',
  request: {
    query: CompareProductsQuerySchema,
  },
  responses: {
    200: {
      description: 'Aligned specSchema + product details',
      content: { 'application/json': { schema: CompareProductsEnvelopeSchema } },
    },
    404: {
      description: 'Fewer than 2 matching active products found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Invalid ids or slugs query parameter',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const recommendationsRoute = createRoute({
  method: 'get',
  path: '/recommendations',
  tags: ['Products'],
  summary: 'Get Product Recommendations',
  description:
    'List recommended and featured products without expensive `ORDER BY RANDOM()` scans.',
  request: {
    query: RecommendationsQuerySchema,
  },
  responses: {
    200: {
      description: 'Recommended product cards',
      content: { 'application/json': { schema: ProductCardListEnvelopeSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const listSparepartsRoute = createRoute({
  method: 'get',
  path: '/{id}/spareparts',
  tags: ['Products'],
  summary: 'List Product Spare Parts',
  description: 'List compatible spare parts for an equipment product with cursor pagination.',
  request: {
    params: ProductIdParamSchema,
    query: CursorPaginationQuerySchema,
  },
  responses: {
    200: {
      description: 'Cursor-paginated spare part cards',
      content: { 'application/json': { schema: SparepartCursorPageSchema } },
    },
    404: {
      description: 'Product not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Invalid product ID or cursor',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getProductBySlugRoute = createRoute({
  method: 'get',
  path: '/{slug}',
  tags: ['Products'],
  summary: 'Get Product by Slug',
  description:
    'Fetch full product detail by slug (media, specs, dimensions, SEO metadata, optional `spareparts` & `related`).',
  request: {
    params: ProductSlugParamSchema,
    query: GetProductDetailQuerySchema,
  },
  responses: {
    200: {
      description: 'Product detail',
      content: { 'application/json': { schema: ProductDetailEnvelopeSchema } },
    },
    404: {
      description: 'Product not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Invalid slug or include parameter',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const listAdminProductsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin - Products'],
  summary: 'Admin: List Products',
  description:
    'List all non-deleted products (including inactive) with cursor or optional numbered `?page=` pagination and `?q=` fuzzy search.',
  security: [{ BearerAuth: [] }],
  request: {
    query: ListAdminProductsQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated admin products',
      content: { 'application/json': { schema: ProductCursorPageSchema } },
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

const getAdminProductRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Admin - Products'],
  summary: 'Admin: Get Product by ID',
  description: 'Fetch any product (active or inactive) by ID.',
  security: [{ BearerAuth: [] }],
  request: {
    params: ProductIdParamSchema,
  },
  responses: {
    200: {
      description: 'Product detail',
      content: { 'application/json': { schema: ProductDetailEnvelopeSchema } },
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
      description: 'Product not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const createProductRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Admin - Products'],
  summary: 'Admin: Create Product',
  description:
    'Create a product with dynamic `specs` validation against its category `effectiveSpecSchema`.',
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateProductBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Product created',
      content: { 'application/json': { schema: ProductDetailEnvelopeSchema } },
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
      description: 'Duplicate slug or SKU',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation or category specSchema check failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateProductRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Admin - Products'],
  summary: 'Admin: Update Product',
  description: 'Update product pricing, stock, media, specs, or SEO fields.',
  security: [{ BearerAuth: [] }],
  request: {
    params: ProductIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateProductBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Product updated',
      content: { 'application/json': { schema: ProductDetailEnvelopeSchema } },
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
      description: 'Product or category not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Duplicate slug or SKU',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation or category specSchema check failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteProductRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Admin - Products'],
  summary: 'Admin: Delete Product',
  description: 'Soft-delete a product.',
  security: [{ BearerAuth: [] }],
  request: {
    params: ProductIdParamSchema,
  },
  responses: {
    204: {
      description: 'Product soft-deleted',
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
      description: 'Product not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const replaceSparepartsRoute = createRoute({
  method: 'put',
  path: '/{id}/spareparts',
  tags: ['Admin - Products'],
  summary: 'Admin: Replace Product Spare Parts',
  description: 'Atomically replace compatible spare-part links for a parent equipment product.',
  security: [{ BearerAuth: [] }],
  request: {
    params: ProductIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: ReplaceSparepartsBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated spare-part links',
      content: {
        'application/json': {
          schema: ProductSparepartsListEnvelopeSchema,
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
    404: {
      description: 'Parent or spare part product not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Self-link or duplicate sparepartProductId',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function createPublicProductsRoutes(productsService: ProductsService) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', publicCache({ maxAgeSec: 60, sMaxAgeSec: 300, staleWhileRevalidateSec: 300 }));

  // Static segments (/compare, /recommendations) MUST be registered before /{slug}.
  return router
    .openapi(listProductsRoute, async (c) => {
      const query = c.req.valid('query');
      const page = await productsService.listPublicProducts(query);
      return c.json(okPage(page, 'Products retrieved successfully'), 200);
    })
    .openapi(compareProductsRoute, async (c) => {
      const query = c.req.valid('query');
      const result = await productsService.compareProducts(query);
      return c.json(
        ok(
          {
            specSchema: [...result.specSchema],
            products: [...result.products],
          },
          'Product comparison retrieved successfully',
        ),
        200,
      );
    })
    .openapi(recommendationsRoute, async (c) => {
      const query = c.req.valid('query');
      const data = await productsService.listRecommendations(query);
      return c.json(ok([...data], 'Product recommendations retrieved successfully'), 200);
    })
    .openapi(listSparepartsRoute, async (c) => {
      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const page = await productsService.listProductSpareparts(id, query);
      return c.json(okPage(page, 'Product spare parts retrieved successfully'), 200);
    })
    .openapi(getProductBySlugRoute, async (c) => {
      const { slug } = c.req.valid('param');
      const query = c.req.valid('query');
      const data = await productsService.getPublicProductBySlug(slug, query);
      return c.json(ok(data, 'Product retrieved successfully'), 200);
    });
}

export function createAdminProductsRoutes(
  productsService: ProductsService,
  authMiddleware: MiddlewareHandler<AppEnv> = requireAuth,
) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', authMiddleware);
  router.use('*', requireAdmin);

  return router
    .openapi(listAdminProductsRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const query = c.req.valid('query');
      const page = await productsService.listAdminProducts(actor, query);
      return c.json(okPage(page, 'Products retrieved successfully'), 200);
    })
    .openapi(getAdminProductRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      const data = await productsService.getAdminProductById(actor, id);
      return c.json(ok(data, 'Product retrieved successfully'), 200);
    })
    .openapi(createProductRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const body = c.req.valid('json');
      const data = await productsService.createProduct(actor, body);
      return c.json(ok(data, 'Product created successfully'), 201);
    })
    .openapi(updateProductRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const data = await productsService.updateProduct(actor, id, body);
      return c.json(ok(data, 'Product updated successfully'), 200);
    })
    .openapi(deleteProductRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      await productsService.deleteProduct(actor, id);
      return c.body(null, 204);
    })
    .openapi(replaceSparepartsRoute, async (c) => {
      const actor = getRequiredAdmin(c);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const data = await productsService.replaceProductSpareparts(actor, id, body);
      return c.json(ok([...data], 'Product spare parts updated successfully'), 200);
    });
}
