import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { signAccessToken } from '@/lib/jwt.ts';
import { ArticleDetailEnvelopeSchema } from '@/modules/articles/articles.schema.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { CategoryEnvelopeSchema, SitemapResponseSchema } from '@/modules/catalog/catalog.schema.ts';
import { createCatalogService } from '@/modules/catalog/catalog.service.ts';
import {
  CompareProductsEnvelopeSchema,
  ProductCursorPageSchema,
  ProductDetailEnvelopeSchema,
} from '@/modules/products/products.schema.ts';
import { createProductsService } from '@/modules/products/products.service.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';
import type { AuthUser } from '@/types/app.ts';

const adminActor: AuthUser = {
  id: '01936c8e-7f2a-7000-8000-000000000901',
  email: 'admin@tsuzumi.test',
  role: 'admin',
};

describe('Products HTTP & cross-module integration (/v1/products, /compare, /articles, /seo/sitemap)', () => {
  async function setupApp() {
    const store = createInMemoryDatastore();
    const adminToken = (await signAccessToken(adminActor)).token;

    const catalogService = createCatalogService(store.catalogRepo);
    const productsService = createProductsService(store.productsRepo, store.catalogRepo);
    const articlesService = createArticlesService(store.articlesRepo, {
      resolveRelatedProducts: (ids) => productsService.resolveRelatedProductCards(ids),
    });

    const testApp = createApp({
      authService: createAuthService(store.authRepo),
      usersService: createUsersService(store.usersRepo),
      catalogService,
      productsService,
      articlesService,
      checkReadiness: () => Promise.resolve(true),
    });

    return { testApp, adminToken };
  }

  test('validates JSONB specs against inherited category schema, supports root-category & SKU search, batch compare, spareparts, and article product hydration', async () => {
    const { testApp, adminToken } = await setupApp();

    // 1. Seed root category + subcategory with inherited specSchema
    const rootCatRes = await testApp.request('/v1/admin/categories', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Genset Silent',
        specSchema: [
          {
            key: 'rated_power_kva',
            label: 'Rated Power',
            unit: 'kVA',
            type: 'number',
            sortOrder: 10,
          },
          { key: 'silent_canopy', label: 'Silent Canopy', type: 'boolean', sortOrder: 20 },
        ],
      }),
    });
    const rootCat = CategoryEnvelopeSchema.parse(await rootCatRes.json()).data;

    const subCatRes = await testApp.request('/v1/admin/categories', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parentId: rootCat.id,
        name: 'Engine Perkins',
        specSchema: [{ key: 'engine_model', label: 'Engine Model', type: 'text', sortOrder: 30 }],
      }),
    });
    const subCat = CategoryEnvelopeSchema.parse(await subCatRes.json()).data;

    // 2. Reject invalid spec value type (string instead of number for rated_power_kva)
    const badSpecsRes = await testApp.request('/v1/admin/products', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        categoryId: subCat.id,
        name: 'Bad Spec Genset',
        priceIdr: 150_000_000,
        specs: { rated_power_kva: 'thirty' },
      }),
    });
    expect(badSpecsRes.status).toBe(422);

    // 3. Create 2 gensets + 1 sparepart oil filter
    const prod1Res = await testApp.request('/v1/admin/products', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        categoryId: subCat.id,
        brandSlug: 'perkins',
        name: 'Genset 30 kVA Silent Diesel Tsuzumi TPG30',
        sku: 'TPG30-SILENT',
        priceIdr: 177_500_000,
        requiresQuote: true,
        stock: 2,
        isFeatured: true,
        weightKg: 920.5,
        media: [
          {
            type: 'video',
            url: 'https://www.youtube.com/watch?v=ObH3ZNu6OFU',
          },
          {
            type: 'image',
            url: 'https://cdn.tsuzumi.test/products/tpg30-main.webp',
            altText: 'Genset TPG30 Front',
          },
        ],
        specs: {
          rated_power_kva: 30,
          silent_canopy: true,
          engine_model: 'Perkins 1103A-33G',
        },
      }),
    });
    expect(prod1Res.status).toBe(201);
    const prod1 = ProductDetailEnvelopeSchema.parse(await prod1Res.json()).data;
    // primaryImageUrl auto-syncs to first 'image' item (skipping leading video)
    expect(prod1.primaryImageUrl).toBe('https://cdn.tsuzumi.test/products/tpg30-main.webp');
    expect(prod1.dimensions.weightKg).toBe(920.5);

    const prod2Res = await testApp.request('/v1/admin/products', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        categoryId: subCat.id,
        brandSlug: 'perkins',
        name: 'Genset 50 kVA Silent Diesel Tsuzumi TPG50',
        sku: 'TPG50-SILENT',
        priceIdr: 235_000_000,
        requiresQuote: true,
        stock: 1,
        specs: {
          rated_power_kva: 50,
          silent_canopy: true,
          engine_model: 'Perkins 1103A-33TG1',
        },
      }),
    });
    expect(prod2Res.status).toBe(201);
    const prod2 = ProductDetailEnvelopeSchema.parse(await prod2Res.json()).data;

    const filterPartRes = await testApp.request('/v1/admin/products', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        categoryId: rootCat.id,
        brandSlug: 'perkins',
        name: 'Perkins Oil Filter 2654403',
        sku: 'PK-2654403',
        productType: 'sparepart',
        priceIdr: 285_000,
        requiresQuote: false,
        stock: 40,
      }),
    });
    expect(filterPartRes.status).toBe(201);
    const filterPart = ProductDetailEnvelopeSchema.parse(await filterPartRes.json()).data;

    // 4. Cannot delete category while products are assigned to it
    const deleteCatConflict = await testApp.request(`/v1/admin/categories/${subCat.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(deleteCatConflict.status).toBe(409);

    // 5. Self-linking sparepart returns 422; valid sparepart link returns 200
    const selfLinkRes = await testApp.request(`/v1/admin/products/${prod1.id}/spareparts`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ sparepartProductId: prod1.id }],
      }),
    });
    expect(selfLinkRes.status).toBe(422);

    const linkRes = await testApp.request(`/v1/admin/products/${prod1.id}/spareparts`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ sparepartProductId: filterPart.id, note: 'Replace every 250 hours' }],
      }),
    });
    expect(linkRes.status).toBe(200);

    // 6. Filtering by root category slug ('genset-silent') includes child subcategory products
    const rootFilterRes = await testApp.request('/v1/products?categorySlug=genset-silent');
    expect(rootFilterRes.status).toBe(200);
    const rootFilterPage = ProductCursorPageSchema.parse(await rootFilterRes.json());
    expect(rootFilterPage.data).toHaveLength(3);

    // SKU search & typo-tolerant fuzzy search ('gensset perkns')
    const skuSearchRes = await testApp.request('/v1/products?q=TPG30');
    const skuSearchPage = ProductCursorPageSchema.parse(await skuSearchRes.json());
    expect(skuSearchPage.data).toHaveLength(1);
    expect(skuSearchPage.data[0]?.sku).toBe('TPG30-SILENT');

    const fuzzyProdRes = await testApp.request('/v1/products?q=gensset%20perkns');
    expect(fuzzyProdRes.status).toBe(200);
    const fuzzyProdPage = ProductCursorPageSchema.parse(await fuzzyProdRes.json());
    expect(fuzzyProdPage.data).toHaveLength(2);

    // 7. Single-hop detail with ?include=spareparts,related
    const detailRes = await testApp.request(
      `/v1/products/${prod1.slug}?include=spareparts,related`,
    );
    expect(detailRes.status).toBe(200);
    const detail = ProductDetailEnvelopeSchema.parse(await detailRes.json()).data;
    expect(detail.spareparts).toHaveLength(1);
    expect(detail.spareparts?.[0]?.note).toBe('Replace every 250 hours');
    expect(detail.related).toHaveLength(1);
    expect(detail.related?.[0]?.id).toBe(prod2.id);

    // 8. Batched /v1/products/compare aligns specSchema + preserves requested slug order
    const compareRes = await testApp.request(
      `/v1/products/compare?slugs=${prod2.slug},${prod1.slug}`,
    );
    expect(compareRes.status).toBe(200);
    const compared = CompareProductsEnvelopeSchema.parse(await compareRes.json()).data;
    expect(compared.specSchema).toHaveLength(3);
    expect(compared.products[0]?.slug).toBe(prod2.slug);
    expect(compared.products[1]?.slug).toBe(prod1.slug);

    // 9. SEO Article hydrates live relatedProducts[] cards & /v1/seo/sitemap lists all 3 products
    const articleRes = await testApp.request('/v1/admin/articles', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Perbandingan Genset Perkins 30 kVA vs 50 kVA',
        contentMd: 'Simak perbandingan spesifikasi berikut...',
        relatedProductIds: [prod1.id, prod2.id],
        isPublished: true,
      }),
    });
    const createdArticle = ArticleDetailEnvelopeSchema.parse(await articleRes.json()).data;

    const publicArticleRes = await testApp.request(`/v1/articles/${createdArticle.slug}`);
    const publicArticle = ArticleDetailEnvelopeSchema.parse(await publicArticleRes.json()).data;
    expect(publicArticle.relatedProducts).toHaveLength(2);
    expect(publicArticle.relatedProducts[0]?.priceIdr).toBe(177_500_000);

    const sitemapRes = await testApp.request('/v1/seo/sitemap');
    const sitemap = SitemapResponseSchema.parse(await sitemapRes.json()).data;
    expect(sitemap.products).toHaveLength(3);
  });
});
