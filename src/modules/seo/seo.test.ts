import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { CreateArticleBodySchema } from '@/modules/articles/articles.schema.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { CreateCategoryBodySchema } from '@/modules/catalog/catalog.schema.ts';
import { createCatalogService } from '@/modules/catalog/catalog.service.ts';
import { CreateProductBodySchema } from '@/modules/products/products.schema.ts';
import { createProductsService } from '@/modules/products/products.service.ts';
import type { RedirectRepository } from '@/modules/seo/redirects.repository.ts';
import {
  type JsonLd,
  type StructuredDataType,
  RedirectEnvelopeSchema,
  StructuredDataEnvelopeSchema,
} from '@/modules/seo/seo.schema.ts';
import { createSeoService } from '@/modules/seo/seo.service.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';
import type { AuthUser } from '@/types/app.ts';

const adminActor: AuthUser = {
  id: '01936c8e-7f2a-7000-8000-000000000901',
  email: 'seo-admin@tsuzumi.test',
  role: 'admin',
};

const SITE_URL = 'https://tsuzumi.test';

function createInMemoryRedirectRepository(): RedirectRepository {
  const rows = new Map<string, { newSlug: string; createdAt: Date }>();
  const key = (entityType: StructuredDataType, slug: string) => `${entityType}:${slug}`;
  return {
    async claimSlug(entityType, slug) {
      rows.delete(key(entityType, slug));
    },
    async recordSlugChange(entityType, oldSlug, newSlug) {
      if (oldSlug === newSlug) return;
      rows.delete(key(entityType, newSlug));
      for (const [storedKey, row] of rows) {
        if (storedKey.startsWith(`${entityType}:`) && row.newSlug === oldSlug) {
          row.newSlug = newSlug;
        }
      }
      rows.set(key(entityType, oldSlug), { newSlug, createdAt: new Date() });
    },
    async findByOldSlug(entityType, oldSlug) {
      const row = rows.get(key(entityType, oldSlug));
      return row === undefined
        ? null
        : {
            entityType,
            oldSlug,
            newSlug: row.newSlug,
            createdAt: row.createdAt.toISOString(),
          };
    },
  };
}

async function setup() {
  const store = createInMemoryDatastore();
  store.seedUser({
    id: adminActor.id,
    email: adminActor.email,
    passwordHash: 'hash',
    displayName: 'SEO Admin',
    role: 'admin',
  });

  const redirectsRepo = createInMemoryRedirectRepository();
  const catalogService = createCatalogService(
    store.catalogRepo,
    undefined,
    undefined,
    redirectsRepo,
  );
  const productsService = createProductsService(
    store.productsRepo,
    store.catalogRepo,
    undefined,
    redirectsRepo,
  );
  const articlesService = createArticlesService(store.articlesRepo, { redirectsRepo });
  const seoService = createSeoService({
    catalogService,
    productsService,
    articlesService,
    siteUrl: SITE_URL,
    siteName: 'Tsuzumi Japan',
    redirectsRepo,
  });
  const testApp = createApp({
    authService: createAuthService(store.authRepo),
    usersService: createUsersService(store.usersRepo),
    catalogService,
    productsService,
    articlesService,
    seoService,
    checkReadiness: () => Promise.resolve(true),
  });

  const category = await catalogService.createCategory(
    adminActor,
    CreateCategoryBodySchema.parse({
      name: 'Genset Silent',
      metaDescription: '**Genset** silent untuk industri.',
    }),
  );
  const product = await productsService.createProduct(
    adminActor,
    CreateProductBodySchema.parse({
      categoryId: category.id,
      name: 'Genset 30 kVA Silent Perkins',
      slug: 'genset-30-kva-silent-perkins',
      brandSlug: 'perkins',
      sku: 'TPG30-SILENT',
      metaDescription: '**Genset** silent untuk industri.',
      priceIdr: 177_500_000,
      stock: 2,
      requiresQuote: false,
    }),
  );
  const article = await articlesService.createArticle(
    adminActor,
    CreateArticleBodySchema.parse({
      title: 'Cara Memilih Genset Silent',
      contentMd: '## Panduan\n\nPilih daya sesuai kebutuhan.',
      excerpt: 'Panduan memilih genset silent untuk industri.',
      isPublished: true,
    }),
  );

  return { seoService, testApp, catalogService, redirectsRepo, category, product, article };
}

function graphNode(graph: readonly JsonLd[], index: number): Record<string, JsonLd> {
  const node = graph[index];
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`Expected JSON-LD object at index ${index}`);
  }
  return node;
}

describe('SeoService structured data (unit)', () => {
  test('builds a Product node with an Offer, Brand and 3-level breadcrumb', async () => {
    const { seoService, product } = await setup();
    const data = await seoService.getStructuredData({ type: 'product', slug: product.slug });

    expect(data['@context']).toBe('https://schema.org');
    const productNode = graphNode(data['@graph'], 0);
    expect(productNode['@type']).toBe('Product');
    expect(productNode['@id']).toBe(`${SITE_URL}/products/${product.slug}#product`);
    expect(productNode['name']).toBe(product.name);
    expect(productNode['sku']).toBe('TPG30-SILENT');
    expect(productNode['description']).toBe('Genset silent untuk industri.');

    const offers = productNode['offers'];
    if (offers === null || typeof offers !== 'object' || Array.isArray(offers)) {
      throw new Error('Expected an Offer node');
    }
    expect(offers['price']).toBe(177_500_000);
    expect(offers['priceCurrency']).toBe('IDR');
    expect(offers['availability']).toBe('https://schema.org/InStock');
    expect(productNode['aggregateRating']).toBeUndefined();

    const breadcrumb = graphNode(data['@graph'], 1);
    expect(breadcrumb['@type']).toBe('BreadcrumbList');
    expect(breadcrumb['itemListElement']).toHaveLength(3);
  });

  test('builds CollectionPage and Article graphs with absolute URLs', async () => {
    const { seoService, category, article } = await setup();

    const categoryData = await seoService.getStructuredData({
      type: 'category',
      slug: category.slug,
    });
    const collectionNode = graphNode(categoryData['@graph'], 0);
    expect(collectionNode['@type']).toBe('CollectionPage');
    expect(collectionNode['url']).toBe(`${SITE_URL}/categories/${category.slug}`);
    expect(collectionNode['description']).toBe('Genset silent untuk industri.');

    const articleData = await seoService.getStructuredData({
      type: 'article',
      slug: article.slug,
    });
    const articleNode = graphNode(articleData['@graph'], 0);
    expect(articleNode['@type']).toBe('Article');
    expect(articleNode['headline']).toBe(article.title);
    expect(articleNode['datePublished']).toBe(article.publishedAt ?? article.createdAt);
    expect(articleNode['publisher']).toMatchObject({
      '@type': 'Organization',
      name: 'Tsuzumi Japan',
      url: SITE_URL,
    });
  });
});

describe('SEO structured-data HTTP route', () => {
  test('returns a JSON-LD graph and validates query params', async () => {
    const { testApp, product } = await setup();

    const res = await testApp.request(`/v1/seo/structured-data?type=product&slug=${product.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('public');
    const body = StructuredDataEnvelopeSchema.parse(await res.json());
    expect(graphNode(body.data['@graph'], 0)['@type']).toBe('Product');

    const invalidRes = await testApp.request('/v1/seo/structured-data?type=product');
    expect(invalidRes.status).toBe(422);

    const missingRes = await testApp.request(
      '/v1/seo/structured-data?type=article&slug=does-not-exist',
    );
    expect(missingRes.status).toBe(404);
  });
});

describe('Permanent slug redirects', () => {
  test('records renames, collapses chains, and exposes a 301 target via the API', async () => {
    const { testApp, catalogService, redirectsRepo, category } = await setup();
    const originalSlug = category.slug;

    await catalogService.updateCategory(adminActor, category.id, {
      slug: 'genset-silent-industrial',
    });
    expect((await redirectsRepo.findByOldSlug('category', originalSlug))?.newSlug).toBe(
      'genset-silent-industrial',
    );

    await catalogService.updateCategory(adminActor, category.id, {
      slug: 'genset-silent-industrial-2026',
    });
    expect((await redirectsRepo.findByOldSlug('category', originalSlug))?.newSlug).toBe(
      'genset-silent-industrial-2026',
    );

    const res = await testApp.request(`/v1/seo/redirect?type=category&slug=${originalSlug}`);
    expect(res.status).toBe(200);
    const body = RedirectEnvelopeSchema.parse(await res.json());
    expect(body.data).toEqual({
      entityType: 'category',
      oldSlug: originalSlug,
      newSlug: 'genset-silent-industrial-2026',
      permanent: true,
    });

    const missingRes = await testApp.request('/v1/seo/redirect?type=product&slug=never-existed');
    expect(missingRes.status).toBe(404);
  });

  test('clears a redirect when a new entity claims the old slug', async () => {
    const { catalogService, redirectsRepo, category } = await setup();
    const originalSlug = category.slug;
    await catalogService.updateCategory(adminActor, category.id, { slug: 'renamed-category' });

    await catalogService.createCategory(
      adminActor,
      CreateCategoryBodySchema.parse({ name: 'Genset Silent', slug: originalSlug }),
    );

    expect(await redirectsRepo.findByOldSlug('category', originalSlug)).toBeNull();
  });
});
