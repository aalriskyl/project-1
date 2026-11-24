import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { ConflictError, ForbiddenError, ValidationError } from '@/lib/errors.ts';
import { generateId } from '@/lib/id.ts';
import { signAccessToken } from '@/lib/jwt.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import {
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
        specSchema: [],
        sortOrder: 0,
        isActive: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const root = await service.createCategory(adminActor, {
      name: 'Genset Silent',
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

    // Conditional request with matching ETag returns 304 Not Modified
    const cachedRes = await testApp.request('/v1/categories?tree=true', {
      headers: { 'If-None-Match': etag ?? '' },
    });
    expect(cachedRes.status).toBe(304);

    const slugDetailRes = await testApp.request('/v1/categories/hand-mixer');
    expect(slugDetailRes.status).toBe(200);
    const slugDetail = CategoryDetailEnvelopeSchema.parse(await slugDetailRes.json());
    expect(slugDetail.data.effectiveSpecSchema).toHaveLength(1);
    expect(slugDetail.data.effectiveSpecSchema[0]?.key).toBe('power_watt');

    const sitemapRes = await testApp.request('/v1/seo/sitemap');
    expect(sitemapRes.status).toBe(200);
    const sitemap = SitemapResponseSchema.parse(await sitemapRes.json());
    expect(sitemap.data.categories).toHaveLength(2);
    expect(sitemap.data.products).toHaveLength(0);
  });
});
