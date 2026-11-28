import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { type ErrorCode, ErrorResponseSchema } from '@/lib/shared/errors.ts';
import { generateId } from '@/lib/auth/id.ts';
import { signAccessToken } from '@/lib/auth/jwt.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { CategoryEnvelopeSchema } from '@/modules/catalog/catalog.schema.ts';
import { createCatalogService } from '@/modules/catalog/catalog.service.ts';
import { createMediaService } from '@/modules/media/media.service.ts';
import { createProductsService } from '@/modules/products/products.service.ts';
import { createReviewsService } from '@/modules/reviews/reviews.service.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';

async function setupFixture() {
  const store = createInMemoryDatastore();
  const admin = store.seedUser({
    id: generateId(),
    email: 'admin@example.com',
    passwordHash: 'hash',
    displayName: 'Admin',
    role: 'admin',
  });
  const user = store.seedUser({
    id: generateId(),
    email: 'member@example.com',
    passwordHash: 'hash',
    displayName: 'Member',
    role: 'user',
  });
  const adminToken = (await signAccessToken(admin)).token;
  const userToken = (await signAccessToken(user)).token;

  const testApp = createApp({
    authService: createAuthService(store.authRepo),
    usersService: createUsersService(store.usersRepo),
    catalogService: createCatalogService(store.catalogRepo),
    productsService: createProductsService(store.productsRepo, store.catalogRepo),
    reviewsService: createReviewsService(store.reviewsRepo, store.productsRepo),
    articlesService: createArticlesService(store.articlesRepo),
    mediaService: createMediaService(store.mediaRepo),
    checkReadiness: () => Promise.resolve(true),
    globalRateLimitMax: 1000,
    authRateLimitMax: 1000,
  });

  return { testApp, store, admin, user, adminToken, userToken };
}

async function expectError(
  response: Response,
  status: number,
  errorCode: ErrorCode,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(ErrorResponseSchema.parse(await response.json()).errorCode).toBe(errorCode);
}

function jsonHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('API negative paths', () => {
  test('rejects non-admin callers on every admin-only route', async () => {
    const { testApp, userToken } = await setupFixture();
    const cases: ReadonlyArray<readonly [string, string, unknown?]> = [
      ['GET', '/v1/admin/products'],
      ['GET', '/v1/admin/reviews'],
      ['POST', '/v1/admin/media/cleanup-orphans', { olderThanHours: 24 }],
    ];

    for (const [method, path, body] of cases) {
      const response = await testApp.request(path, {
        method,
        headers: jsonHeaders(userToken),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      await expectError(response, 403, 'ADMIN_REQUIRED');
    }
  });

  test('returns 404 with RESOURCE_NOT_FOUND for unknown admin by-ID resources', async () => {
    const { testApp, adminToken } = await setupFixture();
    const unknown = generateId();
    const cases: ReadonlyArray<readonly [string, string, ErrorCode, unknown?]> = [
      ['GET', `/v1/users/${unknown}`, 'USER_NOT_FOUND'],
      ['PATCH', `/v1/users/${unknown}`, 'USER_NOT_FOUND', { displayName: 'Nobody' }],
      ['DELETE', `/v1/users/${unknown}`, 'USER_NOT_FOUND'],
      ['GET', `/v1/admin/categories/${unknown}`, 'CATEGORY_NOT_FOUND'],
      ['PATCH', `/v1/admin/categories/${unknown}`, 'CATEGORY_NOT_FOUND', { name: 'Nobody' }],
      ['DELETE', `/v1/admin/categories/${unknown}`, 'CATEGORY_NOT_FOUND'],
      ['GET', `/v1/admin/products/${unknown}`, 'PRODUCT_NOT_FOUND'],
      ['PATCH', `/v1/admin/products/${unknown}`, 'PRODUCT_NOT_FOUND', { name: 'Nobody' }],
      ['DELETE', `/v1/admin/products/${unknown}`, 'PRODUCT_NOT_FOUND'],
      ['GET', `/v1/admin/articles/${unknown}`, 'ARTICLE_NOT_FOUND'],
      ['PATCH', `/v1/admin/articles/${unknown}`, 'ARTICLE_NOT_FOUND', { title: 'Nobody' }],
      ['DELETE', `/v1/admin/articles/${unknown}`, 'ARTICLE_NOT_FOUND'],
      ['PATCH', `/v1/admin/reviews/${unknown}`, 'REVIEW_NOT_FOUND', { isPublished: true }],
      ['DELETE', `/v1/admin/reviews/${unknown}`, 'REVIEW_NOT_FOUND'],
    ];

    for (const [method, path, errorCode, body] of cases) {
      const response = await testApp.request(path, {
        method,
        headers: jsonHeaders(adminToken),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      await expectError(response, 404, errorCode);
    }
  });

  test('reports documented 409 codes for duplicate emails, slugs and SKUs', async () => {
    const { testApp, admin, adminToken } = await setupFixture();

    const duplicateUser = await testApp.request('/v1/users', {
      method: 'POST',
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        email: admin.email,
        password: 'correct-horse-battery-staple',
        displayName: 'Duplicate Admin',
      }),
    });
    await expectError(duplicateUser, 409, 'EMAIL_ALREADY_EXISTS');

    const categoryRes = await testApp.request('/v1/admin/categories', {
      method: 'POST',
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({ name: 'Root Category', slug: 'root-category' }),
    });
    expect(categoryRes.status).toBe(201);
    const categoryId = CategoryEnvelopeSchema.parse(await categoryRes.json()).data.id;

    const productBody = {
      categoryId,
      name: 'Product One',
      slug: 'product-one',
      sku: 'SKU-ONE',
      priceIdr: 1000,
    };
    expect(
      (
        await testApp.request('/v1/admin/products', {
          method: 'POST',
          headers: jsonHeaders(adminToken),
          body: JSON.stringify(productBody),
        })
      ).status,
    ).toBe(201);

    await expectError(
      await testApp.request('/v1/admin/products', {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({ ...productBody, sku: 'SKU-TWO' }),
      }),
      409,
      'SLUG_ALREADY_EXISTS',
    );
    await expectError(
      await testApp.request('/v1/admin/products', {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({ ...productBody, slug: 'product-two' }),
      }),
      409,
      'SKU_ALREADY_EXISTS',
    );
  });

  test('validates recommendations query and rejects spareparts on an unknown product', async () => {
    const { testApp } = await setupFixture();

    await expectError(
      await testApp.request('/v1/products/recommendations?limit=99'),
      422,
      'VALIDATION_ERROR',
    );
    await expectError(
      await testApp.request(`/v1/products/${generateId()}/spareparts`),
      404,
      'PRODUCT_NOT_FOUND',
    );
  });
});
