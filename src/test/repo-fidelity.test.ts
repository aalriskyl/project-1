import { describe, expect, test } from 'bun:test';
import { generateId } from '@/lib/auth/id.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';

describe('in-memory repository join fidelity', () => {
  test('excludes products whose category row is absent, matching the SQL innerJoin', async () => {
    const store = createInMemoryDatastore();
    const orphanCategoryId = generateId();

    await store.productsRepo.create({
      id: generateId(),
      categoryId: orphanCategoryId,
      brandSlug: null,
      name: 'Orphan Product',
      slug: 'orphan-product',
      sku: null,
      productType: 'equipment',
      descriptionMd: null,
      priceIdr: 1_000,
      requiresQuote: false,
      stock: 1,
      isFeatured: false,
      isActive: true,
      primaryImageUrl: null,
      media: [],
      specs: {},
      customSpecs: [],
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      weightKg: null,
      metaTitle: null,
      metaDescription: null,
      focusKeyword: null,
      canonicalUrl: null,
      noIndex: false,
      ogImageUrl: null,
    });

    expect(await store.productsRepo.listAdminCursor({ limit: 10 })).toHaveLength(0);
    const offsetPage = await store.productsRepo.listAdminOffset({ limit: 10, offset: 0 });
    expect(offsetPage.items).toHaveLength(0);
    expect(offsetPage.total).toBe(0);
  });

  test('excludes reviews whose product row is absent, matching the SQL innerJoin', async () => {
    const store = createInMemoryDatastore();
    const missingProductId = generateId();
    const authorId = generateId();
    store.seedUser({
      id: authorId,
      email: 'reviewer@example.com',
      passwordHash: null,
      displayName: 'Reviewer',
    });
    store.seedOrphanReview({
      id: generateId(),
      productId: missingProductId,
      userId: authorId,
      orderId: null,
      rating: 5,
      comment: 'orphan review',
    });

    expect(await store.reviewsRepo.listAdminCursor({ limit: 10 })).toHaveLength(0);
    const offsetPage = await store.reviewsRepo.listAdminOffset({ limit: 10, offset: 0 });
    expect(offsetPage.items).toHaveLength(0);
    expect(offsetPage.total).toBe(0);
    expect(
      await store.reviewsRepo.listPublishedByProductCursor({
        productId: missingProductId,
        limit: 10,
      }),
    ).toHaveLength(0);
  });
});
