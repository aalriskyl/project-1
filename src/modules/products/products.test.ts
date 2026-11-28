import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createApp } from '@/app.ts';
import { signAccessToken } from '@/lib/auth/jwt.ts';
import { ArticleDetailEnvelopeSchema } from '@/modules/articles/articles.schema.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { CategoryEnvelopeSchema, SitemapResponseSchema } from '@/modules/catalog/catalog.schema.ts';
import { createCatalogService } from '@/modules/catalog/catalog.service.ts';
import {
  COMPARE_SLUGS_SUNSET_HTTP_DATE,
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
    store.seedUser({
      id: adminActor.id,
      email: adminActor.email,
      passwordHash: 'hash',
      displayName: 'Products Admin',
      role: 'admin',
    });
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

    // 2b. Reject duplicate labels in customSpecs (case-insensitive)
    const dupCustomSpecsRes = await testApp.request('/v1/admin/products', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        categoryId: subCat.id,
        name: 'Duplicate Custom Spec Genset',
        priceIdr: 150_000_000,
        customSpecs: [
          { label: 'Alternator', value: 'Stamford' },
          { label: 'alternator', value: 'Leroy Somer' },
        ],
      }),
    });
    expect(dupCustomSpecsRes.status).toBe(422);

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
        customSpecs: [
          { label: 'Alternator', value: 'Stamford UCI224D' },
          { label: 'Noise Level', value: '68', unit: 'dB @ 7m' },
        ],
      }),
    });
    expect(prod1Res.status).toBe(201);
    const prod1 = ProductDetailEnvelopeSchema.parse(await prod1Res.json()).data;
    // primaryImageUrl auto-syncs to first 'image' item (skipping leading video)
    expect(prod1.primaryImageUrl).toBe('https://cdn.tsuzumi.test/products/tpg30-main.webp');
    expect(prod1.dimensions.weightKg).toBe(920.5);
    expect(prod1.customSpecs).toEqual([
      { label: 'Alternator', value: 'Stamford UCI224D' },
      { label: 'Noise Level', value: '68', unit: 'dB @ 7m' },
    ]);

    // Update customSpecs via PATCH
    const patchCustomSpecsRes = await testApp.request(`/v1/admin/products/${prod1.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customSpecs: [
          { label: 'Alternator', value: 'Stamford UCI224D' },
          { label: 'Control Panel', value: 'DeepSea DSE4520' },
        ],
      }),
    });
    expect(patchCustomSpecsRes.status).toBe(200);
    const patchedProd1 = ProductDetailEnvelopeSchema.parse(await patchCustomSpecsRes.json()).data;
    expect(patchedProd1.customSpecs).toEqual([
      { label: 'Alternator', value: 'Stamford UCI224D' },
      { label: 'Control Panel', value: 'DeepSea DSE4520' },
    ]);

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

    // Public sorting (?sort=price_asc & price_desc) with keyset cursor pagination + sort mismatch 422
    const priceAscP1 = ProductCursorPageSchema.parse(
      await (await testApp.request('/v1/products?sort=price_asc&limit=2')).json(),
    );
    expect(priceAscP1.data.map((p) => p.priceIdr)).toEqual([285_000, 177_500_000]);
    expect(priceAscP1.meta.hasMore).toBe(true);
    expect(priceAscP1.meta.mode).toBe('cursor');

    const priceAscP2 = ProductCursorPageSchema.parse(
      await (
        await testApp.request(
          `/v1/products?sort=price_asc&limit=2&cursor=${encodeURIComponent(priceAscP1.meta.nextCursor ?? '')}`,
        )
      ).json(),
    );
    expect(priceAscP2.data.map((p) => p.priceIdr)).toEqual([235_000_000]);
    expect(priceAscP2.meta.hasMore).toBe(false);

    const sortMismatchRes = await testApp.request(
      `/v1/products?sort=price_desc&cursor=${encodeURIComponent(priceAscP1.meta.nextCursor ?? '')}`,
    );
    expect(sortMismatchRes.status).toBe(422);

    const priceDesc = ProductCursorPageSchema.parse(
      await (await testApp.request('/v1/products?sort=price_desc')).json(),
    );
    expect(priceDesc.data.map((p) => p.priceIdr)).toEqual([235_000_000, 177_500_000, 285_000]);

    // Admin product filters (?categoryId=, ?brandSlug=, ?type=, ?requiresQuote=, ?inStock=, ?isFeatured=)
    const adminSpareparts = ProductCursorPageSchema.parse(
      await (
        await testApp.request(
          `/v1/admin/products?categoryId=${rootCat.id}&brandSlug=perkins&type=sparepart&requiresQuote=false&inStock=true`,
          {
            headers: { Authorization: `Bearer ${adminToken}` },
          },
        )
      ).json(),
    );
    expect(adminSpareparts.data).toHaveLength(1);
    expect(adminSpareparts.data[0]?.id).toBe(filterPart.id);

    // Public ?inStock=false returns 0 items (all 3 have stock > 0); ?minRating=4 returns 0 (unrated yet)
    const outOfStockRes = ProductCursorPageSchema.parse(
      await (await testApp.request('/v1/products?inStock=false')).json(),
    );
    expect(outOfStockRes.data).toHaveLength(0);

    const inStockRes = ProductCursorPageSchema.parse(
      await (await testApp.request('/v1/products?inStock=true')).json(),
    );
    expect(inStockRes.data).toHaveLength(3);
    expect(inStockRes.data[0]?.category.id).toBe(inStockRes.data[0]?.categoryId);
    expect(inStockRes.data[0]?.category.name.length).toBeGreaterThan(0);

    const adminProdsWithCat = ProductCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/products', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(adminProdsWithCat.data[0]?.category.id).toBe(adminProdsWithCat.data[0]?.categoryId);
    expect(adminProdsWithCat.data[0]?.category.slug.length).toBeGreaterThan(0);

    const minRatingRes = ProductCursorPageSchema.parse(
      await (await testApp.request('/v1/products?minRating=4')).json(),
    );
    expect(minRatingRes.data).toHaveLength(0);

    // 6b. Public categoryId filter (root includes children), mutually exclusive categoryId+categorySlug -> 422,
    // multi-value brandSlug=perkins,cummins, dynamic JSONB specs filter, and spareparts ?q= search
    const byCatIdPage = ProductCursorPageSchema.parse(
      await (await testApp.request(`/v1/products?categoryId=${rootCat.id}`)).json(),
    );
    expect(byCatIdPage.data).toHaveLength(3);

    expect(
      (await testApp.request(`/v1/products?categoryId=${rootCat.id}&categorySlug=genset-silent`))
        .status,
    ).toBe(422);

    const multiBrandPage = ProductCursorPageSchema.parse(
      await (await testApp.request('/v1/products?brandSlug=perkins,cummins')).json(),
    );
    expect(multiBrandPage.data).toHaveLength(3);

    const specsGte40 = ProductCursorPageSchema.parse(
      await (
        await testApp.request(
          '/v1/products?specs=rated_power_kva:gte:40,silent_canopy:eq:true,engine_model:contains:1103A',
        )
      ).json(),
    );
    expect(specsGte40.data).toHaveLength(1);
    expect(specsGte40.data[0]?.id).toBe(prod2.id);

    expect((await testApp.request('/v1/products?specs=rated_power_kva:badop:30')).status).toBe(422);

    const sparepartHit = ProductCursorPageSchema.parse(
      await (await testApp.request(`/v1/products/${prod1.id}/spareparts?q=oil%20filter`)).json(),
    );
    expect(sparepartHit.data).toHaveLength(1);
    expect(sparepartHit.data[0]?.id).toBe(filterPart.id);

    const sparepartMiss = ProductCursorPageSchema.parse(
      await (await testApp.request(`/v1/products/${prod1.id}/spareparts?q=radiator`)).json(),
    );
    expect(sparepartMiss.data).toHaveLength(0);

    // Admin date-range filter: invalid range -> 422; future range -> 0 items
    expect(
      (
        await testApp.request('/v1/admin/products?createdFrom=2030-01-10&createdTo=2030-01-01', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).status,
    ).toBe(422);

    const futureAdminProds = ProductCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/products?createdFrom=2099-01-01', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(futureAdminProds.data).toHaveLength(0);

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

    // 8. Batched /v1/products/compare aligns specSchema + preserves requested order for both ?ids= and ?slugs=
    const compareByIdsRes = await testApp.request(
      `/v1/products/compare?ids=${prod1.id},${prod2.id}`,
    );
    expect(compareByIdsRes.status).toBe(200);
    expect(compareByIdsRes.headers.get('Deprecation')).toBeNull();
    expect(compareByIdsRes.headers.get('Sunset')).toBeNull();
    const comparedByIds = CompareProductsEnvelopeSchema.parse(await compareByIdsRes.json()).data;
    expect(comparedByIds.specSchema).toHaveLength(3);
    expect(comparedByIds.products[0]?.id).toBe(prod1.id);
    expect(comparedByIds.products[0]?.customSpecs).toHaveLength(2);
    expect(comparedByIds.products[1]?.id).toBe(prod2.id);

    const compareRes = await testApp.request(
      `/v1/products/compare?slugs=${prod2.slug},${prod1.slug}`,
    );
    expect(compareRes.status).toBe(200);
    expect(compareRes.headers.get('Deprecation')).toBe('true');
    expect(compareRes.headers.get('Sunset')).toBe(COMPARE_SLUGS_SUNSET_HTTP_DATE);
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

    // 10. Soft-delete marks product inactive (hidden from public, filterable in admin, restorable via PATCH)
    const delProdRes = await testApp.request(`/v1/admin/products/${prod2.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delProdRes.status).toBe(204);
    expect((await testApp.request(`/v1/products/${prod2.slug}`)).status).toBe(404);

    const inactiveProds = ProductCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/products?status=inactive', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(inactiveProds.data).toHaveLength(1);
    expect(inactiveProds.data[0]?.id).toBe(prod2.id);
    expect(inactiveProds.data[0]?.status).toBe('inactive');
    expect(inactiveProds.data[0]?.deletedAt).not.toBeNull();

    const restoreProdRes = await testApp.request(`/v1/admin/products/${prod2.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(restoreProdRes.status).toBe(200);
    const restoredProd = ProductDetailEnvelopeSchema.parse(await restoreProdRes.json()).data;
    expect(restoredProd.status).toBe('active');
    expect(restoredProd.deletedAt).toBeNull();
    expect((await testApp.request(`/v1/products/${prod2.slug}`)).status).toBe(200);

    // Regression H6: spareparts rejects equipment target (422) and non-existent target (404)
    expect(
      (
        await testApp.request(`/v1/admin/products/${prod1.id}/spareparts`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ sparepartProductId: prod2.id }] }),
        })
      ).status,
    ).toBe(422);

    // Regression H8: creating an article with a nonexistent relatedProductId returns 404
    expect(
      (
        await testApp.request('/v1/admin/articles', {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Invalid Related Product Reference',
            contentMd: 'Body',
            relatedProductIds: ['01936c8e-7f2a-7000-8000-999999999999'],
          }),
        })
      ).status,
    ).toBe(404);

    // Regression H10: oversized reviewCount in rating_desc cursor returns 422 (never PG int4 overflow 500)
    const overflowCursor = Buffer.from(
      JSON.stringify({
        sort: 'rating_desc',
        ratingAvg: '4.50',
        reviewCount: 99_999_999_999,
        id: prod1.id,
      }),
      'utf8',
    ).toString('base64url');
    expect(
      (await testApp.request(`/v1/products?sort=rating_desc&cursor=${overflowCursor}`)).status,
    ).toBe(422);
  });

  test('OpenAPI marks the compare slugs parameter as deprecated', async () => {
    const { testApp } = await setupApp();
    const response = await testApp.request('/v1/openapi.json');
    expect(response.status).toBe(200);

    const specSchema = z.object({
      paths: z.record(
        z.string(),
        z.object({
          get: z
            .object({
              parameters: z
                .array(z.object({ name: z.string(), deprecated: z.boolean().optional() }))
                .optional(),
            })
            .optional(),
        }),
      ),
    });
    const { paths } = specSchema.parse(await response.json());
    const parameters = paths['/v1/products/compare']?.get?.parameters ?? [];
    expect(parameters.find((param) => param.name === 'slugs')?.deprecated).toBe(true);
    expect(parameters.find((param) => param.name === 'ids')?.deprecated).toBeUndefined();
  });

  test('exposes Deprecation and Sunset headers to allowed CORS origins', async () => {
    const { testApp } = await setupApp();
    const response = await testApp.request('/health', {
      headers: { Origin: 'http://localhost:3000' },
    });
    const exposed = response.headers.get('Access-Control-Expose-Headers') ?? '';
    expect(exposed).toContain('Deprecation');
    expect(exposed).toContain('Sunset');
  });
});
