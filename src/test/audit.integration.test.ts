import { describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createApp } from '@/app.ts';
import type { Database } from '@/db/client.ts';
import * as schema from '@/db/schema/index.ts';
import { generateId } from '@/lib/auth/id.ts';
import { signAccessToken } from '@/lib/auth/jwt.ts';
import { createRedisRateLimitStore } from '@/lib/integrations/redis-rate-limit.ts';
import type { StorageProvider } from '@/lib/integrations/storage.ts';
import { createArticlesRepository } from '@/modules/articles/articles.repository.ts';
import {
  CreateArticleBodySchema,
  ArticleDetailEnvelopeSchema,
} from '@/modules/articles/articles.schema.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthRepository } from '@/modules/auth/auth.repository.ts';
import { createCatalogRepository } from '@/modules/catalog/catalog.repository.ts';
import { createCatalogService } from '@/modules/catalog/catalog.service.ts';
import { withMediaMutation } from '@/modules/media/media-attachments.repository.ts';
import { createMediaRepository } from '@/modules/media/media.repository.ts';
import { SignedUploadUrlEnvelopeSchema } from '@/modules/media/media.schema.ts';
import { createMediaService } from '@/modules/media/media.service.ts';
import { createNotificationsRepository } from '@/modules/notifications/notifications.repository.ts';
import { createProductsRepository } from '@/modules/products/products.repository.ts';
import { createProductsService } from '@/modules/products/products.service.ts';
import { createReviewsRepository } from '@/modules/reviews/reviews.repository.ts';
import { createReviewsService } from '@/modules/reviews/reviews.service.ts';
import type { AuthUser } from '@/types/app.ts';

const databaseUrl = process.env['TEST_DATABASE_URL'];
interface Fixture {
  db: Database;
  actor: AuthUser;
  productId: string;
  categoryId: string;
  reviewers: string[];
}
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!databaseUrl) throw new Error('Local test database is required');
  const client = postgres(databaseUrl, { prepare: false, max: 12, onnotice: false });
  const db = drizzle(client, { schema });
  const actor: AuthUser = {
    id: generateId(),
    email: `audit-${generateId()}@example.com`,
    role: 'admin',
  };
  const reviewers = Array.from({ length: 8 }, () => generateId());
  const ids = [actor.id, ...reviewers];
  const categoryId = generateId();
  const productId = generateId();
  try {
    await db.insert(schema.users).values(
      ids.map((id) => ({
        id,
        email: id === actor.id ? actor.email : `${id}@example.com`,
        displayName: 'Integration User',
        role: id === actor.id ? 'admin' : 'user',
      })),
    );
    await db
      .insert(schema.categories)
      .values({ id: categoryId, name: 'Audit category', slug: categoryId });
    await db.insert(schema.products).values({
      id: productId,
      categoryId,
      name: 'Audit product',
      slug: productId,
      priceIdr: 1000,
    });
    await run({ db, actor, productId, categoryId, reviewers });
  } finally {
    await db
      .delete(schema.mailOutbox)
      .where(
        inArray(
          schema.mailOutbox.id,
          db
            .select({ id: schema.passwordResetTokens.id })
            .from(schema.passwordResetTokens)
            .where(inArray(schema.passwordResetTokens.userId, ids)),
        ),
      );
    await db.delete(schema.articles).where(eq(schema.articles.authorId, actor.id));
    await db.delete(schema.mediaUploads).where(eq(schema.mediaUploads.uploadedBy, actor.id));
    await db.delete(schema.products).where(eq(schema.products.id, productId));
    await db.delete(schema.categories).where(eq(schema.categories.id, categoryId));
    await db.delete(schema.users).where(inArray(schema.users.id, ids));
    await client.end({ timeout: 5 });
  }
}

describe.skipIf(!databaseUrl)('Audit regressions against real local PostgreSQL', () => {
  test('enforces media completion and keeps inline references through real HTTP repositories', async () => {
    await withFixture(async ({ db, actor }) => {
      const catalogRepo = createCatalogRepository(db),
        productsRepo = createProductsRepository(db);
      const mediaRepo = createMediaRepository(db);
      const provider: StorageProvider = {
        createSignedImageUpload(input) {
          const objectPath = `articles/${generateId()}.png`;
          return Promise.resolve({
            bucket: 'public-assets',
            objectPath,
            publicUrl: `https://example.supabase.co/storage/v1/object/public/public-assets/${objectPath}`,
            uploadUrl: `https://example.supabase.co/upload/${objectPath}`,
            token: 'test',
            expiresInSec: 7200,
            requiredHeaders: { 'Content-Type': input.contentType },
          });
        },
        verifyImageUpload: () => Promise.resolve(),
        deleteObjects: () => Promise.resolve(),
      };
      const app = createApp({
        catalogService: createCatalogService(catalogRepo),
        productsService: createProductsService(productsRepo, catalogRepo),
        articlesService: createArticlesService(createArticlesRepository(db)),
        mediaService: createMediaService(mediaRepo, provider),
      });
      const headers = {
        Authorization: `Bearer ${(await signAccessToken(actor)).token}`,
        'Content-Type': 'application/json',
      };
      const signedResponse = await app.request('/v1/admin/media/upload-url', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          folder: 'articles',
          contentType: 'image/png',
          contentLengthBytes: 48,
        }),
      });
      expect(signedResponse.status).toBe(201);
      const signed = SignedUploadUrlEnvelopeSchema.parse(await signedResponse.json()).data;
      const save = () =>
        app.request('/v1/admin/articles', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title: 'Real database media',
            contentMd: `![inline](${signed.publicUrl})`,
          }),
        });
      expect((await save()).status).toBe(409);
      expect(
        (
          await app.request(`/v1/admin/media/${signed.uploadId}/complete`, {
            method: 'POST',
            headers,
          })
        ).status,
      ).toBe(200);
      const saved = await save();
      expect(saved.status).toBe(201);
      const article = ArticleDetailEnvelopeSchema.parse(await saved.json()).data;
      await db
        .update(schema.mediaUploads)
        .set({ createdAt: new Date(0) })
        .where(eq(schema.mediaUploads.id, signed.uploadId));
      expect(await mediaRepo.claimOrphans({ olderThan: new Date(), limit: 1 })).toHaveLength(0);
      const refs = await db
        .select()
        .from(schema.mediaReferences)
        .where(eq(schema.mediaReferences.ownerId, article.id));
      expect(refs).toHaveLength(1);
      await createArticlesRepository(db).softDeleteById(article.id, new Date());
      expect(await mediaRepo.claimOrphans({ olderThan: new Date(), limit: 1 })).toHaveLength(1);
      expect(
        (
          await app.request(`/v1/admin/media/${signed.uploadId}/complete`, {
            method: 'POST',
            headers,
          })
        ).status,
      ).toBe(409);
    });
  });

  test('serializes attachment commits and orphan claims without holding network work in transactions', async () => {
    await withFixture(async ({ db, actor }) => {
      const repo = createMediaRepository(db);
      const uploadId = generateId();
      const path = `articles/${uploadId}.png`;
      const publicUrl = `https://example.supabase.co/storage/v1/object/public/public-assets/${path}`;
      await repo.recordUpload({
        id: uploadId,
        bucket: 'public-assets',
        objectPath: path,
        publicUrl,
        contentType: 'image/png',
        expectedBytes: 48,
        uploadedBy: actor.id,
      });
      await repo.markVerified(uploadId, new Date());
      await db
        .update(schema.mediaUploads)
        .set({ createdAt: new Date(0) })
        .where(eq(schema.mediaUploads.id, uploadId));
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const raceArticleId = generateId();
      const attachment = withMediaMutation(db, 'articles', raceArticleId, async (tx) => {
        const [row] = await tx
          .insert(schema.articles)
          .values({
            id: raceArticleId,
            authorId: actor.id,
            title: 'Race article',
            slug: generateId(),
            contentMd: publicUrl,
          })
          .returning();
        if (!row) throw new Error('Article insert failed');
        entered.resolve(undefined);
        await release.promise;
        return row;
      });
      await entered.promise;
      const cleanup = repo.claimOrphans({ olderThan: new Date(), limit: 1 });
      release.resolve(undefined);
      await attachment;
      expect(await cleanup).toHaveLength(0);
      await expect(
        createArticlesService(createArticlesRepository(db)).createArticle(
          actor,
          CreateArticleBodySchema.parse({
            title: 'Unverified article',
            contentMd: 'Text',
            coverImageUrl:
              'https://example.supabase.co/storage/v1/object/public/public-assets/missing.png',
          }),
        ),
      ).rejects.toMatchObject({ code: 'MEDIA_NOT_VERIFIED' });
    });
  });

  test('keeps rating rollups correct across concurrent review writes and moderation', async () => {
    await withFixture(async ({ db, productId, reviewers }) => {
      const repo = createReviewsRepository(db);
      const reviews = await Promise.all(
        reviewers.map((userId, i) =>
          repo.createAndSyncProductRating({
            id: generateId(),
            productId,
            userId,
            orderId: null,
            rating: i % 2 === 0 ? 5 : 3,
            comment: null,
          }),
        ),
      );
      const [product] = await db
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, productId));
      expect(product?.reviewCount).toBe(8);
      expect(Number(product?.ratingAvg)).toBe(4);
      const first = reviews[0],
        second = reviews[1];
      if (!first || !second) throw new Error('Missing review fixtures');
      await Promise.all([
        repo.updatePublishStateAndSyncRating(first.id, false),
        repo.deleteAndSyncRating(second.id),
      ]);
      const [updated] = await db
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, productId));
      expect(updated?.reviewCount).toBe(6);
      expect(Number(updated?.ratingAvg)).toBe(4);
      const service = createReviewsService(repo, createProductsRepository(db));
      await expect(
        service.createProductReview(
          { id: reviewers[0] ?? '', email: 'test@example.com', role: 'user' },
          productId,
          { rating: 5 },
        ),
      ).rejects.toThrow();
    });
  });

  test('commits reset tokens with delivery jobs atomically and leases jobs across workers', async () => {
    await withFixture(async ({ db, actor }) => {
      const repo = createAuthRepository(db),
        id = generateId();
      const expiresAt = new Date(Date.now() + 60000);
      await repo.createPasswordResetToken(
        { id, userId: actor.id, tokenHash: generateId(), expiresAt },
        { id, payload: 'encrypted-fixture', expiresAt },
      );
      const notifications = createNotificationsRepository(db);
      const claims = await Promise.all([
        notifications.claim(new Date()),
        notifications.claim(new Date()),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const failedId = generateId();
      await expect(
        repo.createPasswordResetToken(
          { id: failedId, userId: actor.id, tokenHash: generateId(), expiresAt },
          { id, payload: 'duplicate-job', expiresAt },
        ),
      ).rejects.toThrow();
      expect(
        await db
          .select()
          .from(schema.passwordResetTokens)
          .where(eq(schema.passwordResetTokens.id, failedId)),
      ).toHaveLength(0);
      const claimed = claims.find((v) => v !== null);
      if (!claimed?.leaseId) throw new Error('Expected leased job');
      await notifications.finish(id, claimed.leaseId, new Date());
      const [done] = await db.select().from(schema.mailOutbox).where(eq(schema.mailOutbox.id, id));
      expect(done?.payload).toBeNull();
      const rls = await db.execute<{ tablename: string; rowsecurity: boolean }>(
        sql`select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename in ('media_references', 'mail_outbox')`,
      );
      expect(rls).toHaveLength(2);
      expect(rls.every((r) => r.rowsecurity)).toBe(true);
    });
  });

  test('resolves relation summaries through real SQL joins', async () => {
    await withFixture(async ({ db, actor, productId, categoryId, reviewers }) => {
      const parentCategoryId = generateId();
      const childCategoryId = generateId();
      const articleId = generateId();
      const reviewId = generateId();
      try {
        await db.insert(schema.categories).values([
          { id: parentCategoryId, name: 'Join parent', slug: parentCategoryId },
          {
            id: childCategoryId,
            parentId: parentCategoryId,
            name: 'Join child',
            slug: childCategoryId,
          },
        ]);
        await db.insert(schema.articles).values({
          id: articleId,
          authorId: actor.id,
          title: 'Join article',
          slug: articleId,
          contentMd: 'Body',
        });
        const reviewer = reviewers[0];
        if (reviewer === undefined) throw new Error('Missing reviewer fixture');
        await db.insert(schema.productReviews).values({
          id: reviewId,
          productId,
          userId: reviewer,
          rating: 5,
        });

        const child = await createCatalogRepository(db).findById(childCategoryId);
        expect(child?.parentId).toBe(parentCategoryId);
        expect(child?.parentName).toBe('Join parent');
        expect(child?.parentSlug).toBe(parentCategoryId);

        const [card] = await createProductsRepository(db).findActiveCardsByIds([productId]);
        expect(card?.categoryId).toBe(categoryId);
        expect(card?.categoryName).toBe('Audit category');
        expect(card?.categorySlug).toBe(categoryId);

        const article = await createArticlesRepository(db).findById(articleId);
        expect(article?.authorName).toBe('Integration User');

        const [review] = await createReviewsRepository(db).listPublishedByProductCursor({
          productId,
          limit: 5,
        });
        expect(review?.productId).toBe(productId);
        expect(review?.productName).toBe('Audit product');
        expect(review?.productSlug).toBe(productId);
        expect(review?.authorName).toBe('Integration User');
      } finally {
        await db.delete(schema.productReviews).where(eq(schema.productReviews.id, reviewId));
        await db.delete(schema.articles).where(eq(schema.articles.id, articleId));
        await db
          .delete(schema.categories)
          .where(inArray(schema.categories.id, [childCategoryId, parentCategoryId]));
      }
    });
  });
});

const redisUrl = process.env['TEST_REDIS_URL'];
describe.skipIf(!redisUrl)('Shared Redis rate-limit integration', () => {
  test('counts atomically across clients and expires windows', async () => {
    if (!redisUrl || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(redisUrl).hostname))
      throw new Error('TEST_REDIS_URL must be local');
    const a = new RedisClient(redisUrl),
      b = new RedisClient(redisUrl);
    const key = `integration-${generateId()}`;
    try {
      const stores = [createRedisRateLimitStore(a), createRedisRateLimitStore(b)];
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => {
          const store = stores[i % 2];
          if (!store) throw new Error('Missing store');
          return store.increment(key, 60000);
        }),
      );
      expect(results.map((r) => r.count).sort((x, y) => x - y)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      await a.send('PEXPIREAT', [`rate-limit:${key}`, '1']);
      expect((await createRedisRateLimitStore(b).increment(key, 60000)).count).toBe(1);
    } finally {
      await a.send('DEL', [`rate-limit:${key}`]);
      a.close();
      b.close();
    }
  });
});
