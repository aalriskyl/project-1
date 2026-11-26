import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { signAccessToken } from '@/lib/jwt.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { CategoryEnvelopeSchema } from '@/modules/catalog/catalog.schema.ts';
import { createCatalogService } from '@/modules/catalog/catalog.service.ts';
import { createMediaService } from '@/modules/media/media.service.ts';
import { ProductDetailEnvelopeSchema } from '@/modules/products/products.schema.ts';
import { createProductsService } from '@/modules/products/products.service.ts';
import {
  ProductReviewCursorPageSchema,
  ProductReviewEnvelopeSchema,
} from '@/modules/reviews/reviews.schema.ts';
import { createReviewsService } from '@/modules/reviews/reviews.service.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';
import type { AuthUser } from '@/types/app.ts';

describe('Product Reviews & transactional rating rollups (/v1/products/:id/reviews, /v1/admin/reviews)', () => {
  test('creates customer reviews, prevents duplicates, recalculates product ratingAvg/reviewCount on create, moderate, and delete', async () => {
    const store = createInMemoryDatastore();

    const adminUser = store.seedUser({
      id: '01936c8e-7f2a-7000-8000-000000000801',
      email: 'admin@tsuzumi.test',
      passwordHash: 'hash',
      displayName: 'Admin',
      role: 'admin',
    });
    const buyer1 = store.seedUser({
      id: '01936c8e-7f2a-7000-8000-000000000802',
      email: 'budi@example.com',
      passwordHash: 'hash',
      displayName: 'Budi Santoso',
      role: 'user',
    });
    const buyer2 = store.seedUser({
      id: '01936c8e-7f2a-7000-8000-000000000803',
      email: 'siti@example.com',
      passwordHash: 'hash',
      displayName: 'Siti Rahma',
      role: 'user',
    });

    const adminActor: AuthUser = { id: adminUser.id, email: adminUser.email, role: 'admin' };
    const buyer1Actor: AuthUser = { id: buyer1.id, email: buyer1.email, role: 'user' };
    const buyer2Actor: AuthUser = { id: buyer2.id, email: buyer2.email, role: 'user' };

    const adminToken = (await signAccessToken(adminActor)).token;
    const buyer1Token = (await signAccessToken(buyer1Actor)).token;
    const buyer2Token = (await signAccessToken(buyer2Actor)).token;

    const testApp = createApp({
      authService: createAuthService(store.authRepo),
      usersService: createUsersService(store.usersRepo),
      catalogService: createCatalogService(store.catalogRepo),
      productsService: createProductsService(store.productsRepo, store.catalogRepo),
      reviewsService: createReviewsService(store.reviewsRepo, store.productsRepo),
      articlesService: createArticlesService(store.articlesRepo),
      mediaService: createMediaService(store.mediaRepo),
      checkReadiness: () => Promise.resolve(true),
    });

    const catRes = await testApp.request('/v1/admin/categories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alat Cat' }),
    });
    const cat = CategoryEnvelopeSchema.parse(await catRes.json()).data;

    const prodRes = await testApp.request('/v1/admin/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categoryId: cat.id,
        name: 'Hand Mixer THM16-3',
        priceIdr: 800_000,
        stock: 5,
      }),
    });
    const prod = ProductDetailEnvelopeSchema.parse(await prodRes.json()).data;

    // Unauthenticated POST fails with 401
    const unauthRes = await testApp.request(`/v1/products/${prod.id}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 5, comment: 'Mantap!' }),
    });
    expect(unauthRes.status).toBe(401);

    // Buyer 1 submits 5-star review
    const rev1Res = await testApp.request(`/v1/products/${prod.id}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${buyer1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 5, comment: 'Kuat dan awet dipakai proyek.' }),
    });
    expect(rev1Res.status).toBe(201);
    const rev1 = ProductReviewEnvelopeSchema.parse(await rev1Res.json()).data;
    expect(rev1.authorName).toBe('Budi Santoso');

    // Duplicate review by Buyer 1 returns 409
    const dupRes = await testApp.request(`/v1/products/${prod.id}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${buyer1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 4 }),
    });
    expect(dupRes.status).toBe(409);

    // Buyer 2 submits 4-star review -> ratingAvg becomes 4.5, reviewCount = 2
    const forgedPurchase = await testApp.request(`/v1/products/${prod.id}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${buyer2Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 5, orderId: '01936c8e-7f2a-7000-8000-000000000999' }),
    });
    expect(forgedPurchase.status).toBe(422);
    const rev2Res = await testApp.request(`/v1/products/${prod.id}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${buyer2Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 4, comment: 'Pengiriman cepat.' }),
    });
    expect(rev2Res.status).toBe(201);
    const rev2 = ProductReviewEnvelopeSchema.parse(await rev2Res.json()).data;

    const listRes = await testApp.request(`/v1/products/${prod.id}/reviews`);
    expect(listRes.status).toBe(200);
    const listPage = ProductReviewCursorPageSchema.parse(await listRes.json());
    expect(listPage.data).toHaveLength(2);

    // Public review star-rating filter (?rating=4)
    const fourStarRes = await testApp.request(`/v1/products/${prod.id}/reviews?rating=4`);
    expect(fourStarRes.status).toBe(200);
    const fourStarPage = ProductReviewCursorPageSchema.parse(await fourStarRes.json());
    expect(fourStarPage.data).toHaveLength(1);
    expect(fourStarPage.data[0]?.id).toBe(rev2.id);

    // Admin review filters (?userId=, ?q=)
    const adminByUser = ProductReviewCursorPageSchema.parse(
      await (
        await testApp.request(`/v1/admin/reviews?userId=${rev2.userId}&q=cepat`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(adminByUser.data).toHaveLength(1);
    expect(adminByUser.data[0]?.id).toBe(rev2.id);

    expect(
      (
        await testApp.request('/v1/admin/reviews?createdFrom=2030-05-01&createdTo=2030-01-01', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).status,
    ).toBe(422);

    const futureReviews = ProductReviewCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/reviews?createdFrom=2099-01-01', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(futureReviews.data).toHaveLength(0);

    const prodAfter2 = ProductDetailEnvelopeSchema.parse(
      await (await testApp.request(`/v1/products/${prod.slug}`)).json(),
    ).data;
    expect(prodAfter2.ratingAvg).toBe(4.5);
    expect(prodAfter2.reviewCount).toBe(2);

    // Admin unpublishes Buyer 2's review -> ratingAvg updates to 5, reviewCount = 1
    const unpubRes = await testApp.request(`/v1/admin/reviews/${rev2.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublished: false }),
    });
    expect(unpubRes.status).toBe(200);

    const prodAfterUnpub = ProductDetailEnvelopeSchema.parse(
      await (await testApp.request(`/v1/products/${prod.slug}`)).json(),
    ).data;
    expect(prodAfterUnpub.ratingAvg).toBe(5);
    expect(prodAfterUnpub.reviewCount).toBe(1);

    // Admin reviews moderation list supports ?isPublished=false & optional ?page= with total/totalPages
    const adminUnpubList = ProductReviewCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/reviews?isPublished=false&page=1&limit=10', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(adminUnpubList.data).toHaveLength(1);
    expect(adminUnpubList.meta.total).toBe(1);
    expect(adminUnpubList.meta.totalPages).toBe(1);

    // Admin soft-deletes Buyer 1's review -> status='inactive', ratingAvg resets to 0, reviewCount = 0
    const delRes = await testApp.request(`/v1/admin/reviews/${rev1.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(204);

    const prodAfterDel = ProductDetailEnvelopeSchema.parse(
      await (await testApp.request(`/v1/products/${prod.slug}`)).json(),
    ).data;
    expect(prodAfterDel.ratingAvg).toBe(0);
    expect(prodAfterDel.reviewCount).toBe(0);

    // Soft-deleted review remains visible in admin ?status=inactive and can be restored via PATCH
    const inactiveReviews = ProductReviewCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/reviews?status=inactive', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(inactiveReviews.data).toHaveLength(1);
    expect(inactiveReviews.data[0]?.id).toBe(rev1.id);
    expect(inactiveReviews.data[0]?.status).toBe('inactive');
    expect(inactiveReviews.data[0]?.deletedAt).not.toBeNull();

    const restoreRevRes = await testApp.request(`/v1/admin/reviews/${rev1.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', isPublished: true }),
    });
    expect(restoreRevRes.status).toBe(200);
    const restoredRev = ProductReviewEnvelopeSchema.parse(await restoreRevRes.json()).data;
    expect(restoredRev.status).toBe('active');
    expect(restoredRev.deletedAt).toBeNull();

    const prodAfterRestore = ProductDetailEnvelopeSchema.parse(
      await (await testApp.request(`/v1/products/${prod.slug}`)).json(),
    ).data;
    expect(prodAfterRestore.ratingAvg).toBe(5);
    expect(prodAfterRestore.reviewCount).toBe(1);

    // Customer edits own review via PATCH /v1/products/:id/reviews/me -> ratingAvg recalculates to 3
    const editOwnRes = await testApp.request(`/v1/products/${prod.id}/reviews/me`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${buyer1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 3, comment: 'Updated after heavy usage.' }),
    });
    expect(editOwnRes.status).toBe(200);
    const editedOwn = ProductReviewEnvelopeSchema.parse(await editOwnRes.json()).data;
    expect(editedOwn.rating).toBe(3);
    expect(editedOwn.comment).toBe('Updated after heavy usage.');

    const prodAfterOwnEdit = ProductDetailEnvelopeSchema.parse(
      await (await testApp.request(`/v1/products/${prod.slug}`)).json(),
    ).data;
    expect(prodAfterOwnEdit.ratingAvg).toBe(3);
    expect(prodAfterOwnEdit.reviewCount).toBe(1);

    // Customer soft-deletes own review via DELETE /v1/products/:id/reviews/me -> ratingAvg resets to 0
    const delOwnRes = await testApp.request(`/v1/products/${prod.id}/reviews/me`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${buyer1Token}` },
    });
    expect(delOwnRes.status).toBe(204);

    const prodAfterOwnDel = ProductDetailEnvelopeSchema.parse(
      await (await testApp.request(`/v1/products/${prod.slug}`)).json(),
    ).data;
    expect(prodAfterOwnDel.ratingAvg).toBe(0);
    expect(prodAfterOwnDel.reviewCount).toBe(0);

    // Deleting again returns 404 (no active own review left)
    expect(
      (
        await testApp.request(`/v1/products/${prod.id}/reviews/me`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${buyer1Token}` },
        })
      ).status,
    ).toBe(404);
  });
});
