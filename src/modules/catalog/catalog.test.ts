import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { ConflictError, ForbiddenError, ValidationError } from '@/lib/errors.ts';
import { generateId } from '@/lib/id.ts';
import { signAccessToken } from '@/lib/jwt.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import {
  CategoryCursorPageSchema,
  CategoryDetailEnvelopeSchema,
  CategoryEnvelopeSchema,
  CategoryListEnvelopeSchema,
  SitemapResponseSchema,
} from '@/modules/catalog/catalog.schema.ts';
import { createCatalogService } from '@/modules/catalog/catalog.service.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';
import type { AuthUser } from '@/types/app.ts';

const adminActor: AuthUser = {
  id: '01936c8e-7f2a-7000-8000-000000000901',
  email: 'admin@tsuzumi.test',
  role: 'admin',
};

const regularActor: AuthUser = {
  id: '01936c8e-7f2a-7000-8000-000000000902',
  email: 'user@tsuzumi.test',
  role: 'user',
};

describe('CatalogService (unit)', () => {
  test('merges inherited parent specSchema, enforces max depth 2, prevents deleting non-empty parent, and triggers revalidation tags', async () => {
    const store = createInMemoryDatastore();
    const notifiedTags: string[][] = [];
    const service = createCatalogService(store.catalogRepo, {
      notify(tags) {
        notifiedTags.push([...tags]);
      },
    });

    await expect(
      service.createCategory(regularActor, {
        name: 'Forbidden Cat',
        noIndex: false,
        specSchema: [],
        sortOrder: 0,
        isActive: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const root = await service.createCategory(adminActor, {
      name: 'Genset Silent',
      noIndex: false,
      specSchema: [
        {
          key: 'rated_power_kva',
          label: 'Rated Power',
          unit: 'kVA',
          type: 'number',
          sortOrder: 10,
        },
        { key: 'voltage', label: 'Voltage', unit: 'V', type: 'text', sortOrder: 20 },
      ],
      sortOrder: 1,
      isActive: true,
    });
    expect(root.slug).toBe('genset-silent');
    expect(notifiedTags.length).toBe(1);

    const child = await service.createCategory(adminActor, {
      parentId: root.id,
      name: 'Engine Perkins',
      noIndex: false,
      specSchema: [
        {
          key: 'voltage',
          label: 'Output Voltage (3-Phase)',
          unit: 'V',
          type: 'text',
          sortOrder: 20,
        },
        { key: 'engine_model', label: 'Perkins Model', type: 'text', sortOrder: 30 },
      ],
      sortOrder: 1,
      isActive: true,
    });

    // Attempting level-3 nesting must fail with ValidationError
    await expect(
      service.createCategory(adminActor, {
        parentId: child.id,
        name: 'Too Deep Level 3',
        noIndex: false,
        specSchema: [],
        sortOrder: 1,
        isActive: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Subcategory detail inherits rated_power_kva, overrides voltage, and appends engine_model
    const detail = await service.getPublicCategoryBySlug('engine-perkins');
    expect(detail.parent?.slug).toBe('genset-silent');
    expect(detail.effectiveSpecSchema).toHaveLength(3);
    expect(detail.effectiveSpecSchema[0]?.key).toBe('rated_power_kva');
    expect(detail.effectiveSpecSchema[1]?.label).toBe('Output Voltage (3-Phase)');
    expect(detail.effectiveSpecSchema[2]?.key).toBe('engine_model');

    // Deleting root while child exists must fail with 409 ConflictError
    await expect(service.deleteCategory(adminActor, root.id)).rejects.toBeInstanceOf(ConflictError);

    await service.deleteCategory(adminActor, child.id);
    await service.deleteCategory(adminActor, root.id);
  });
});

describe('Catalog & SEO HTTP routes (/v1/categories, /v1/admin/categories, /v1/seo/sitemap)', () => {
  async function setupApp() {
    const store = createInMemoryDatastore();
    store.seedUser({
      id: adminActor.id,
      email: adminActor.email,
      passwordHash: 'hash',
      displayName: 'Catalog Admin',
      role: 'admin',
    });
    store.seedUser({
      id: regularActor.id,
      email: regularActor.email,
      passwordHash: 'hash',
      displayName: 'Regular User',
      role: 'user',
    });
    const adminToken = (await signAccessToken(adminActor)).token;
    const userToken = (await signAccessToken(regularActor)).token;

    const testApp = createApp({
      authService: createAuthService(store.authRepo),
      usersService: createUsersService(store.usersRepo),
      catalogService: createCatalogService(store.catalogRepo),
      articlesService: createArticlesService(store.articlesRepo),
      checkReadiness: () => Promise.resolve(true),
    });

    return { testApp, adminToken, userToken, id: generateId() };
  }

  test('enforces admin RBAC, builds category tree, supports ETag 304 Not Modified, and serves /v1/seo/sitemap', async () => {
    const { testApp, adminToken, userToken } = await setupApp();

    const forbiddenRes = await testApp.request('/v1/admin/categories', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Alat Cat' }),
    });
    expect(forbiddenRes.status).toBe(403);

    const dupSpecKeyRes = await testApp.request('/v1/admin/categories', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Alat Cat',
        specSchema: [
          { key: 'pressure_bar', label: 'Pressure', type: 'number' },
          { key: 'pressure_bar', label: 'Duplicate', type: 'number' },
        ],
      }),
    });
    expect(dupSpecKeyRes.status).toBe(422);

    const rootRes = await testApp.request('/v1/admin/categories', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Alat Cat',
        metaTitle: 'Jual Alat Cat & Hand Mixer | Tsuzumi',
        specSchema: [{ key: 'power_watt', label: 'Daya Listrik', unit: 'W', type: 'number' }],
      }),
    });
    expect(rootRes.status).toBe(201);
    const rootCreated = CategoryEnvelopeSchema.parse(await rootRes.json());

    const subRes = await testApp.request('/v1/admin/categories', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parentId: rootCreated.data.id,
        name: 'Hand Mixer',
      }),
    });
    expect(subRes.status).toBe(201);

    const treeRes = await testApp.request('/v1/categories?tree=true');
    expect(treeRes.status).toBe(200);
    const etag = treeRes.headers.get('ETag');
    expect(etag).not.toBeNull();
    expect(treeRes.headers.get('Cache-Control')).toContain('public, max-age=300');

    const treeData = CategoryListEnvelopeSchema.parse(await treeRes.json());
    expect(treeData.data).toHaveLength(1);
    const firstRoot = treeData.data[0];
    expect(firstRoot !== undefined && 'children' in firstRoot && firstRoot.children.length).toBe(1);

    // Regression H11: contradictory tree=true + rootOnly=false or parentId returns 422
    expect((await testApp.request('/v1/categories?tree=true&rootOnly=false')).status).toBe(422);
    expect(
      (await testApp.request(`/v1/categories?tree=true&parentId=${rootCreated.data.id}`)).status,
    ).toBe(422);

    // Conditional request with matching ETag (including multi-ETag header) returns 304 Not Modified
    const cachedRes = await testApp.request('/v1/categories?tree=true', {
      headers: { 'If-None-Match': etag ?? '' },
    });
    expect(cachedRes.status).toBe(304);

    const multiEtagRes = await testApp.request('/v1/categories?tree=true', {
      headers: { 'If-None-Match': `W/"stale-tag", ${etag ?? ''}` },
    });
    expect(multiEtagRes.status).toBe(304);

    const slugDetailRes = await testApp.request('/v1/categories/hand-mixer');
    expect(slugDetailRes.status).toBe(200);
    const slugDetail = CategoryDetailEnvelopeSchema.parse(await slugDetailRes.json());
    expect(slugDetail.data.effectiveSpecSchema).toHaveLength(1);
    expect(slugDetail.data.effectiveSpecSchema[0]?.key).toBe('power_watt');

    // Fuzzy search with typo ('mixr') matches subcategory 'Hand Mixer' and keeps its parent in tree mode
    const fuzzyCatRes = await testApp.request('/v1/categories?tree=true&q=mixr');
    expect(fuzzyCatRes.status).toBe(200);
    const fuzzyCatData = CategoryListEnvelopeSchema.parse(await fuzzyCatRes.json());
    expect(fuzzyCatData.data).toHaveLength(1);
    const fuzzyRoot = fuzzyCatData.data[0];
    expect(fuzzyRoot !== undefined && 'children' in fuzzyRoot && fuzzyRoot.children[0]?.slug).toBe(
      'hand-mixer',
    );

    const sitemapRes = await testApp.request('/v1/seo/sitemap');
    expect(sitemapRes.status).toBe(200);
    const sitemap = SitemapResponseSchema.parse(await sitemapRes.json());
    expect(sitemap.data.categories).toHaveLength(2);
    expect(sitemap.data.products).toHaveLength(0);

    // Admin categories supports optional ?page= with total/totalPages and rejects cursor+page together
    const adminPageRes = await testApp.request('/v1/admin/categories?page=1&limit=1', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(adminPageRes.status).toBe(200);
    const adminPage = CategoryCursorPageSchema.parse(await adminPageRes.json());
    expect(adminPage.data).toHaveLength(1);
    expect(adminPage.meta.page).toBe(1);
    expect(adminPage.meta.total).toBe(2);
    expect(adminPage.meta.totalPages).toBe(2);
    expect(adminPage.meta.hasMore).toBe(true);

    // Category filters: ?rootOnly=true, ?parentId=, and mutually exclusive ?rootOnly=true&parentId= -> 422
    const rootOnlyPublic = CategoryListEnvelopeSchema.parse(
      await (await testApp.request('/v1/categories?rootOnly=true')).json(),
    );
    expect(rootOnlyPublic.data).toHaveLength(1);
    expect(rootOnlyPublic.data[0]?.id).toBe(rootCreated.data.id);

    const childrenByParentPublic = CategoryListEnvelopeSchema.parse(
      await (await testApp.request(`/v1/categories?parentId=${rootCreated.data.id}`)).json(),
    );
    expect(childrenByParentPublic.data).toHaveLength(1);
    expect(childrenByParentPublic.data[0]?.slug).toBe('hand-mixer');

    expect(
      (await testApp.request(`/v1/categories?rootOnly=true&parentId=${rootCreated.data.id}`))
        .status,
    ).toBe(422);

    const adminSubOnly = CategoryCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/categories?rootOnly=false', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(adminSubOnly.data).toHaveLength(1);
    expect(adminSubOnly.data[0]?.parentId).toBe(rootCreated.data.id);

    const badComboRes = await testApp.request('/v1/admin/categories?page=1&cursor=abc', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(badComboRes.status).toBe(422);

    // Deactivating root category via PATCH while active child exists must fail with 409 (matching DELETE)
    const patchDeactivateRoot = await testApp.request(
      `/v1/admin/categories/${rootCreated.data.id}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'inactive' }),
      },
    );
    expect(patchDeactivateRoot.status).toBe(409);

    // Soft-delete subcategory -> status='inactive', hidden from public, visible in admin GET /:id & ?status=inactive, restorable via PATCH
    const subCreated = CategoryEnvelopeSchema.parse(await subRes.json()).data;
    const delSubRes = await testApp.request(`/v1/admin/categories/${subCreated.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delSubRes.status).toBe(204);
    expect((await testApp.request('/v1/categories/hand-mixer')).status).toBe(404);

    // Admin can still fetch inactive category by ID (with parent & effectiveSpecSchema)
    const adminGetInactiveCat = await testApp.request(`/v1/admin/categories/${subCreated.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(adminGetInactiveCat.status).toBe(200);
    const inactiveCatDetail = CategoryDetailEnvelopeSchema.parse(await adminGetInactiveCat.json());
    expect(inactiveCatDetail.data.status).toBe('inactive');
    expect(inactiveCatDetail.data.deletedAt).not.toBeNull();
    expect(inactiveCatDetail.data.parent?.id).toBe(rootCreated.data.id);
    expect(inactiveCatDetail.data.effectiveSpecSchema).toHaveLength(1);

    // Non-admin cannot access GET /v1/admin/categories/:id
    expect(
      (
        await testApp.request(`/v1/admin/categories/${subCreated.id}`, {
          headers: { Authorization: `Bearer ${userToken}` },
        })
      ).status,
    ).toBe(403);

    const inactiveCats = CategoryCursorPageSchema.parse(
      await (
        await testApp.request('/v1/admin/categories?status=inactive', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(inactiveCats.data).toHaveLength(1);
    expect(inactiveCats.data[0]?.id).toBe(subCreated.id);
    expect(inactiveCats.data[0]?.status).toBe('inactive');
    expect(inactiveCats.data[0]?.deletedAt).not.toBeNull();

    // Conflicting status + isActive returns 422
    const conflictPatch = await testApp.request(`/v1/admin/categories/${subCreated.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', isActive: false }),
    });
    expect(conflictPatch.status).toBe(422);

    // Restore via PATCH { status: 'active' }
    const restoreSubRes = await testApp.request(`/v1/admin/categories/${subCreated.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(restoreSubRes.status).toBe(200);
    const restoredSub = CategoryEnvelopeSchema.parse(await restoreSubRes.json()).data;
    expect(restoredSub.status).toBe('active');
    expect(restoredSub.isActive).toBe(true);
    expect(restoredSub.deletedAt).toBeNull();
    expect((await testApp.request('/v1/categories/hand-mixer')).status).toBe(200);
  });
});
