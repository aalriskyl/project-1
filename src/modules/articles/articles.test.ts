import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { signAccessToken } from '@/lib/auth/jwt.ts';
import {
  ArticleCursorPageSchema,
  ArticleDetailEnvelopeSchema,
} from '@/modules/articles/articles.schema.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { SitemapResponseSchema } from '@/modules/catalog/catalog.schema.ts';
import { createCatalogService } from '@/modules/catalog/catalog.service.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';
import type { AuthUser } from '@/types/app.ts';

const adminActor: AuthUser = {
  id: '01936c8e-7f2a-7000-8000-000000000901',
  email: 'seo-admin@tsuzumi.test',
  role: 'admin',
};

const userActor: AuthUser = {
  id: '01936c8e-7f2a-7000-8000-000000000902',
  email: 'customer@tsuzumi.test',
  role: 'user',
};

describe('Articles HTTP routes (/v1/articles, /v1/admin/articles)', () => {
  async function setupApp() {
    const store = createInMemoryDatastore();
    store.seedUser({
      id: adminActor.id,
      email: adminActor.email,
      passwordHash: 'hash',
      displayName: 'SEO Admin',
      role: 'admin',
    });
    store.seedUser({
      id: userActor.id,
      email: userActor.email,
      passwordHash: 'hash',
      displayName: 'Customer',
      role: 'user',
    });
    const adminToken = (await signAccessToken(adminActor)).token;
    const userToken = (await signAccessToken(userActor)).token;
    const revalidated: string[][] = [];

    const testApp = createApp({
      authService: createAuthService(store.authRepo),
      usersService: createUsersService(store.usersRepo),
      catalogService: createCatalogService(store.catalogRepo),
      articlesService: createArticlesService(store.articlesRepo, {
        revalidator: {
          async notify(tags) {
            revalidated.push([...tags]);
          },
        },
      }),
      checkReadiness: () => Promise.resolve(true),
    });

    return { testApp, adminToken, userToken, revalidated };
  }

  test('manages draft -> publish lifecycle, tag filtering, cursor pagination, related articles, and sitemap inclusion', async () => {
    const { testApp, adminToken, userToken, revalidated } = await setupApp();

    // Non-admin cannot create articles
    const forbiddenRes = await testApp.request('/v1/admin/articles', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Unauthorized Post',
        contentMd: 'Body',
      }),
    });
    expect(forbiddenRes.status).toBe(403);

    // 1. Create a draft article
    const draftRes = await testApp.request('/v1/admin/articles', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Mesin Potong Aspal: Fungsi dan Spesifikasi',
        excerpt: 'Panduan memilih concrete cutter untuk proyek jalan.',
        contentMd: '## Fungsi Mesin Potong Aspal\n\nDigunakan pada konstruksi jalan...',
        metaTitle: 'Mesin Potong Aspal Terbaik | Tsuzumi Japan',
        focusKeyword: 'mesin potong aspal',
        canonicalUrl: 'https://tsuzumijapan.com/articles/mesin-potong-aspal-fungsi-dan-spesifikasi',
        ogImageUrl: 'https://placehold.co/1200x630.webp',
        tags: ['Konstruksi', 'Cutting', 'konstruksi'],
        relatedProductIds: ['01936c8e-7f2a-7000-8000-000000000555'],
        isPublished: false,
      }),
    });
    expect(draftRes.status).toBe(201);
    const draft = ArticleDetailEnvelopeSchema.parse(await draftRes.json());
    expect(draft.data.slug).toBe('mesin-potong-aspal-fungsi-dan-spesifikasi');
    expect(draft.data.tags).toEqual(['konstruksi', 'cutting']);
    expect(draft.data.publishedAt).toBeNull();
    expect(draft.data.author).toEqual({ id: adminActor.id, name: 'SEO Admin' });

    // Draft must NOT be visible publicly or in sitemap
    const publicDraftRes = await testApp.request(`/v1/articles/${draft.data.slug}`);
    expect(publicDraftRes.status).toBe(404);

    // Admin can still read the draft by ID
    const adminReadDraft = await testApp.request(`/v1/admin/articles/${draft.data.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(adminReadDraft.status).toBe(200);

    // 2. Publish the draft + create a second published article sharing 'konstruksi' tag
    const publishRes = await testApp.request(`/v1/admin/articles/${draft.data.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isPublished: true }),
    });
    expect(publishRes.status).toBe(200);
    const published = ArticleDetailEnvelopeSchema.parse(await publishRes.json());
    expect(published.data.publishedAt).not.toBeNull();
    expect(revalidated.some((tags) => tags.includes('articles'))).toBe(true);

    const secondRes = await testApp.request('/v1/admin/articles', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Cara Merawat Genset Silent 30 kVA',
        contentMd: '## Jadwal Ganti Oli\n\nSetiap 250 jam kerja...',
        tags: ['genset', 'konstruksi'],
        isPublished: true,
      }),
    });
    expect(secondRes.status).toBe(201);

    // Duplicate slug returns 409
    const dupSlugRes = await testApp.request('/v1/admin/articles', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Duplicate Title',
        slug: draft.data.slug,
        contentMd: 'Content',
      }),
    });
    expect(dupSlugRes.status).toBe(409);

    // 3. Public tag filter, fuzzy text search ('aspall'), and cursor pagination
    const gensetTagRes = await testApp.request('/v1/articles?tag=genset');
    expect(gensetTagRes.status).toBe(200);
    const gensetPage = ArticleCursorPageSchema.parse(await gensetTagRes.json());
    expect(gensetPage.data).toHaveLength(1);
    expect(gensetPage.data[0]?.slug).toBe('cara-merawat-genset-silent-30-kva');

    const fuzzyArticleRes = await testApp.request('/v1/articles?q=aspall');
    expect(fuzzyArticleRes.status).toBe(200);
    const fuzzyArticlePage = ArticleCursorPageSchema.parse(await fuzzyArticleRes.json());
    expect(fuzzyArticlePage.data).toHaveLength(1);
    expect(fuzzyArticlePage.data[0]?.slug).toBe('mesin-potong-aspal-fungsi-dan-spesifikasi');

    // Public ?productId= filters published articles linked to that product
    const linkedProductId = draft.data.relatedProductIds[0] ?? '';
    const byProductRes = await testApp.request(`/v1/articles?productId=${linkedProductId}`);
    expect(byProductRes.status).toBe(200);
    const byProductPage = ArticleCursorPageSchema.parse(await byProductRes.json());
    expect(byProductPage.data).toHaveLength(1);
    expect(byProductPage.data[0]?.id).toBe(draft.data.id);

    // Admin ?isPublished=false returns only drafts, ?isPublished=true returns published
    const adminDraftOnly = ArticleCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/articles?isPublished=false', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(adminDraftOnly.data).toHaveLength(0);

    const adminPubByProduct = ArticleCursorPageSchema.parse(
      await (
        await testApp.request(`/v1/admin/articles?isPublished=true&productId=${linkedProductId}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(adminPubByProduct.data).toHaveLength(1);
    expect(adminPubByProduct.data[0]?.id).toBe(draft.data.id);

    expect(
      (
        await testApp.request('/v1/admin/articles?createdFrom=2030-05-01&createdTo=2030-01-01', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).status,
    ).toBe(422);

    const futureArticles = ArticleCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/articles?createdFrom=2099-01-01', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(futureArticles.data).toHaveLength(0);

    const page1Res = await testApp.request('/v1/articles?limit=1');
    const page1 = ArticleCursorPageSchema.parse(await page1Res.json());
    expect(page1.data).toHaveLength(1);
    expect(page1.meta.hasMore).toBe(true);

    const page2Res = await testApp.request(
      `/v1/articles?limit=1&cursor=${encodeURIComponent(page1.meta.nextCursor ?? '')}`,
    );
    const page2 = ArticleCursorPageSchema.parse(await page2Res.json());
    expect(page2.data).toHaveLength(1);
    expect(page2.meta.hasMore).toBe(false);

    // 4. Public detail with ?includeRelated=true
    const detailRes = await testApp.request(`/v1/articles/${draft.data.slug}?includeRelated=true`);
    expect(detailRes.status).toBe(200);
    const detail = ArticleDetailEnvelopeSchema.parse(await detailRes.json());
    expect(detail.data.relatedProductIds).toHaveLength(1);
    expect(detail.data.relatedArticles).toHaveLength(1);
    expect(detail.data.relatedArticles?.[0]?.slug).toBe('cara-merawat-genset-silent-30-kva');

    // 5. Published article with noIndex=true is excluded from /v1/seo/sitemap; insecure http:// canonicalUrl is rejected
    const badCanonicalRes = await testApp.request('/v1/admin/articles', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Bad Canonical Post',
        contentMd: 'Body',
        canonicalUrl: 'http://insecure.example.com/post',
      }),
    });
    expect(badCanonicalRes.status).toBe(422);

    const noIndexRes = await testApp.request('/v1/admin/articles', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Hidden Promo Page',
        contentMd: 'NoIndex body',
        noIndex: true,
        isPublished: true,
      }),
    });
    expect(noIndexRes.status).toBe(201);

    const sitemapRes = await testApp.request('/v1/seo/sitemap');
    const sitemap = SitemapResponseSchema.parse(await sitemapRes.json());
    expect(sitemap.data.articles).toHaveLength(2);
    expect(sitemap.data.articles.some((a) => a.slug === 'hidden-promo-page')).toBe(false);

    // 6. Soft-delete marks article inactive (hidden from public, filterable in admin, restorable via PATCH)
    const delRes = await testApp.request(`/v1/admin/articles/${draft.data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(204);

    const afterDelRes = await testApp.request(`/v1/articles/${draft.data.slug}`);
    expect(afterDelRes.status).toBe(404);

    const inactiveArticles = ArticleCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/articles?status=inactive', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(inactiveArticles.data).toHaveLength(1);
    expect(inactiveArticles.data[0]?.id).toBe(draft.data.id);
    expect(inactiveArticles.data[0]?.status).toBe('inactive');
    expect(inactiveArticles.data[0]?.deletedAt).not.toBeNull();

    const restoreArticleRes = await testApp.request(`/v1/admin/articles/${draft.data.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(restoreArticleRes.status).toBe(200);
    const restoredArticle = ArticleDetailEnvelopeSchema.parse(await restoreArticleRes.json()).data;
    expect(restoredArticle.status).toBe('active');
    expect(restoredArticle.deletedAt).toBeNull();
    expect((await testApp.request(`/v1/articles/${draft.data.slug}`)).status).toBe(200);
  });
});
