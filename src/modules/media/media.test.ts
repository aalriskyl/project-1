import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { isAllowedAssetImageUrl, isAllowedAssetVideoUrl } from '@/lib/asset-url.ts';
import { generateId } from '@/lib/id.ts';
import { ConflictError } from '@/lib/errors.ts';
import { signAccessToken } from '@/lib/jwt.ts';
import { createSupabaseStorageProvider, type StorageProvider } from '@/lib/storage.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { createCatalogService } from '@/modules/catalog/catalog.service.ts';
import {
  CleanupOrphansEnvelopeSchema,
  SignedUploadUrlEnvelopeSchema,
} from '@/modules/media/media.schema.ts';
import { createMediaService } from '@/modules/media/media.service.ts';
import { createProductsService } from '@/modules/products/products.service.ts';
import { createReviewsService } from '@/modules/reviews/reviews.service.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';
import type { AuthUser } from '@/types/app.ts';

const adminActor: AuthUser = {
  id: '01936c8e-7f2a-7000-8000-000000000901',
  email: 'admin@tsuzumi.test',
  role: 'admin',
};

const userActor: AuthUser = {
  id: '01936c8e-7f2a-7000-8000-000000000902',
  email: 'user@tsuzumi.test',
  role: 'user',
};

describe('Asset URL policy & Media orphan sweep (/v1/admin/media/*)', () => {
  test('enforces strict Storage bucket URL prefix in production and YouTube/Storage allowlist for videos', () => {
    const prodPolicy = {
      nodeEnv: 'production' as const,
      supabaseUrl: 'https://proj.supabase.co',
      bucket: 'public-assets',
    };

    expect(
      isAllowedAssetImageUrl(
        'https://proj.supabase.co/storage/v1/object/public/public-assets/products/2026/11/a.webp',
        prodPolicy,
      ),
    ).toBe(true);

    // Rejects arbitrary external hotlinks and placeholder domains in production
    expect(isAllowedAssetImageUrl('https://placehold.co/800x600.webp', prodPolicy)).toBe(false);
    expect(isAllowedAssetImageUrl('https://evil.example.com/pixel.png', prodPolicy)).toBe(false);
    expect(
      isAllowedAssetImageUrl(
        'http://proj.supabase.co/storage/v1/object/public/public-assets/a.webp',
        prodPolicy,
      ),
    ).toBe(false);

    // Videos allow YouTube or our Storage bucket, but reject arbitrary hosts
    expect(isAllowedAssetVideoUrl('https://www.youtube.com/watch?v=ObH3ZNu6OFU', prodPolicy)).toBe(
      true,
    );
    expect(isAllowedAssetVideoUrl('https://evil.example.com/video.mp4', prodPolicy)).toBe(false);
  });

  test('tracks uploads, rejects untrusted external image URLs on save, and sweeps only unreferenced orphans >24h old (preserving inline Markdown images)', async () => {
    const store = createInMemoryDatastore();
    store.seedUser({
      id: adminActor.id,
      email: adminActor.email,
      passwordHash: 'hash',
      displayName: 'Media Admin',
      role: 'admin',
    });
    store.seedUser({
      id: userActor.id,
      email: userActor.email,
      passwordHash: 'hash',
      displayName: 'Media User',
      role: 'user',
    });
    const adminToken = (await signAccessToken(adminActor)).token;
    const userToken = (await signAccessToken(userActor)).token;
    const deletedFromStorage: string[] = [];
    let uploaded = false;

    const mockProvider: StorageProvider = {
      verifyImageUpload() {
        return uploaded
          ? Promise.resolve()
          : Promise.reject(new ConflictError('File missing', 'MEDIA_UPLOAD_MISSING'));
      },
      createSignedImageUpload(input) {
        const objectPath = `${input.folder}/2026/11/01936c8e-7f2a-7000-8000-000000000333.webp`;
        return Promise.resolve({
          bucket: 'public-assets',
          objectPath,
          uploadUrl: `https://example.supabase.co/storage/v1/object/upload/sign/public-assets/${objectPath}?token=signed-tok`,
          publicUrl: `https://example.supabase.co/storage/v1/object/public/public-assets/${objectPath}`,
          token: 'signed-tok',
          expiresInSec: 7200,
          requiredHeaders: { 'Content-Type': input.contentType },
        });
      },
      deleteObjects(_bucket, objectPaths) {
        deletedFromStorage.push(...objectPaths);
        return Promise.resolve();
      },
    };

    const testApp = createApp({
      authService: createAuthService(store.authRepo),
      usersService: createUsersService(store.usersRepo),
      catalogService: createCatalogService(store.catalogRepo),
      productsService: createProductsService(store.productsRepo, store.catalogRepo),
      reviewsService: createReviewsService(store.reviewsRepo, store.productsRepo),
      articlesService: createArticlesService(store.articlesRepo),
      mediaService: createMediaService(store.mediaRepo, mockProvider),
      checkReadiness: () => Promise.resolve(true),
    });

    // 403 for non-admin user
    const forbiddenRes = await testApp.request('/v1/admin/media/upload-url', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        folder: 'products',
        contentType: 'image/webp',
        contentLengthBytes: 120_000,
      }),
    });
    expect(forbiddenRes.status).toBe(403);

    // 422 for SVG
    const svgRes = await testApp.request('/v1/admin/media/upload-url', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        folder: 'products',
        contentType: 'image/svg+xml',
        contentLengthBytes: 10_000,
      }),
    });
    expect(svgRes.status).toBe(422);

    // 422 when trying to save an untrusted external coverImageUrl on an article
    const untrustedImgArticle = await testApp.request('/v1/admin/articles', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Untrusted Cover Post',
        contentMd: 'Body',
        coverImageUrl: 'https://untrusted-tracker.example.org/pixel.png',
      }),
    });
    expect(untrustedImgArticle.status).toBe(422);

    // 201 presigned upload URL
    const okRes = await testApp.request('/v1/admin/media/upload-url', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        folder: 'products',
        contentType: 'image/webp',
        contentLengthBytes: 250_000,
      }),
    });
    expect(okRes.status).toBe(201);
    const signed = SignedUploadUrlEnvelopeSchema.parse(await okRes.json());
    expect(signed.data.bucket).toBe('public-assets');
    const completeUrl = `/v1/admin/media/${signed.data.uploadId}/complete`;
    expect((await testApp.request(completeUrl, { method: 'POST' })).status).toBe(401);
    expect(
      (
        await testApp.request(completeUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${userToken}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await testApp.request('/v1/admin/media/invalid/complete', {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await testApp.request(completeUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).status,
    ).toBe(409);
    const saveImage = () =>
      testApp.request('/v1/admin/articles', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Verified upload article',
          contentMd: 'Test',
          coverImageUrl: signed.data.publicUrl,
        }),
      });
    expect((await saveImage()).status).toBe(409);
    uploaded = true;
    for (let i = 0; i < 2; i += 1)
      expect(
        (
          await testApp.request(completeUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${adminToken}` },
          })
        ).status,
      ).toBe(200);
    expect((await saveImage()).status).toBe(201);

    // Seed 3 uploads created 48h ago:
    // 1) cover.webp (used as coverImageUrl)
    // 2) inline.webp (embedded inside Markdown contentMd!)
    // 3) abandoned.webp (never referenced -> must be deleted)
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600 * 1_000);
    const coverPath = 'articles/2026/11/cover.webp';
    const inlinePath = 'articles/2026/11/inline.webp';
    const orphanPath = 'articles/2026/11/abandoned.webp';

    for (const path of [coverPath, inlinePath, orphanPath]) {
      store.seedMediaUpload({
        id: generateId(),
        bucket: 'public-assets',
        objectPath: path,
        publicUrl: `https://example.supabase.co/storage/v1/object/public/public-assets/${path}`,
        contentType: 'image/webp',
        uploadedBy: adminActor.id,
        createdAt: twoDaysAgo,
      });
    }

    const articleRes = await testApp.request('/v1/admin/articles', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Panduan Instalasi Genset',
        coverImageUrl: `https://example.supabase.co/storage/v1/object/public/public-assets/${coverPath}`,
        contentMd: `Diagram instalasi:\n\n![Wiring](https://example.supabase.co/storage/v1/object/public/public-assets/${inlinePath})`,
        isPublished: true,
      }),
    });
    expect(articleRes.status).toBe(201);

    const sweepRes = await testApp.request('/v1/admin/media/cleanup-orphans', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ olderThanHours: 24, limit: 1 }),
    });
    expect(sweepRes.status).toBe(200);
    const sweep = CleanupOrphansEnvelopeSchema.parse(await sweepRes.json()).data;
    expect(sweep.scannedCount).toBe(1);
    expect(sweep.deletedCount).toBe(1);
    expect(sweep.deletedPaths).toEqual([orphanPath]);
    expect(deletedFromStorage).toEqual([orphanPath]);

    // Regression C4: bodyless cleanup-orphans request uses schema defaults and returns 200 (never 500)
    const bodylessSweepRes = await testApp.request('/v1/admin/media/cleanup-orphans', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(bodylessSweepRes.status).toBe(200);
    const bodylessSweep = CleanupOrphansEnvelopeSchema.parse(await bodylessSweepRes.json()).data;
    expect(bodylessSweep.deletedCount).toBe(0);

    // Unconfigured Storage returns 503 cleanly
    const unconfiguredApp = createApp({
      authService: createAuthService(store.authRepo),
      usersService: createUsersService(store.usersRepo),
      catalogService: createCatalogService(store.catalogRepo),
      productsService: createProductsService(store.productsRepo, store.catalogRepo),
      reviewsService: createReviewsService(store.reviewsRepo, store.productsRepo),
      articlesService: createArticlesService(store.articlesRepo),
      mediaService: createMediaService(
        store.mediaRepo,
        createSupabaseStorageProvider({ bucket: 'public-assets' }),
      ),
      checkReadiness: () => Promise.resolve(true),
    });

    const unconfiguredRes = await unconfiguredApp.request('/v1/admin/media/upload-url', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        folder: 'products',
        contentType: 'image/png',
        contentLengthBytes: 50_000,
      }),
    });
    expect(unconfiguredRes.status).toBe(503);
  });
});
