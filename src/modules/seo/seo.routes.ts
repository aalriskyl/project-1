import { OpenAPIHono } from '@hono/zod-openapi';
import { createNamedRoute } from '@/lib/api/openapi.ts';

const createRoute = createNamedRoute('seo');
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/shared/errors.ts';
import { ok } from '@/lib/api/response.ts';
import { publicCache } from '@/middlewares/cache/cache-control.ts';
import { SitemapResponseSchema } from '@/modules/catalog/catalog.schema.ts';
import type { CatalogService } from '@/modules/catalog/catalog.service.ts';
import {
  RedirectEnvelopeSchema,
  StructuredDataEnvelopeSchema,
  StructuredDataQuerySchema,
} from '@/modules/seo/seo.schema.ts';
import type { SeoService } from '@/modules/seo/seo.service.ts';
import type { AppEnv } from '@/types/app.ts';

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

const getStructuredDataRoute = createRoute({
  method: 'get',
  path: '/structured-data',
  tags: ['SEO'],
  summary: 'Get JSON-LD Structured Data',
  description:
    'Build a schema.org `@graph` (Product, CollectionPage, Article, BreadcrumbList) for an entity slug. The frontend injects the returned object into a `<script type="application/ld+json">` tag during server rendering.',
  request: {
    query: StructuredDataQuerySchema,
  },
  responses: {
    200: {
      description: 'JSON-LD graph ready to be serialized into the page head',
      content: { 'application/json': { schema: StructuredDataEnvelopeSchema } },
    },
    404: {
      description: 'No published entity exists for the given type and slug',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getRedirectRoute = createRoute({
  method: 'get',
  path: '/redirect',
  tags: ['SEO'],
  summary: 'Resolve a Permanent Slug Redirect',
  description:
    'Resolve an old category/product/article slug to its current slug after a rename, so the frontend can issue a 301 instead of serving a 404.',
  request: {
    query: StructuredDataQuerySchema,
  },
  responses: {
    200: {
      description: 'Permanent redirect target for the old slug',
      content: { 'application/json': { schema: RedirectEnvelopeSchema } },
    },
    404: {
      description: 'No permanent redirect is registered for this slug',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function createSeoRoutes(catalogService: CatalogService, seoService: SeoService) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', publicCache({ maxAgeSec: 300, sMaxAgeSec: 3600, staleWhileRevalidateSec: 3600 }));

  return router
    .openapi(getSitemapRoute, async (c) => {
      const data = await catalogService.getSitemap();
      return c.json(ok(data, 'Sitemap feed retrieved successfully'), 200);
    })
    .openapi(getStructuredDataRoute, async (c) => {
      const data = await seoService.getStructuredData(c.req.valid('query'));
      return c.json(ok(data, 'Structured data generated successfully'), 200);
    })
    .openapi(getRedirectRoute, async (c) => {
      const data = await seoService.getRedirect(c.req.valid('query'));
      return c.json(ok(data, 'Permanent redirect resolved'), 200);
    });
}
