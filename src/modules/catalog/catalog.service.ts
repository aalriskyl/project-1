import { z } from '@hono/zod-openapi';
import type { SpecFieldDefRow } from '@/db/schema/categories.ts';
import { noopCache, type ResponseCache } from '@/lib/cache.ts';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors.ts';
import { generateId } from '@/lib/id.ts';
import { type CursorPage, paginateAdminList } from '@/lib/pagination.ts';
import { type RevalidateNotifier, revalidateNotifier } from '@/lib/revalidate.ts';
import { slugify } from '@/lib/slug.ts';
import { isRecordActive, resolveActiveStateInput, toRecordStatus } from '@/lib/status.ts';
import { assertAdminUser } from '@/middlewares/authorize.ts';
import type {
  CatalogRepository,
  CategoryWithParentRow,
} from '@/modules/catalog/catalog.repository.ts';
import {
  type CategoryDetail,
  CategorySchema,
  type CategoryTreeNode,
  CategoryTreeNodeSchema,
  type CreateCategoryBody,
  type ListAdminCategoriesQuery,
  type ListCategoriesQuery,
  type PublicCategory,
  type SitemapData,
  SitemapEntrySchema,
  type SpecFieldDef,
  type UpdateCategoryBody,
} from '@/modules/catalog/catalog.schema.ts';
import type { AuthUser } from '@/types/app.ts';

const CATEGORIES_CACHE_TTL_SEC = 300;
const SITEMAP_CACHE_TTL_SEC = 600;
const CachedCategoryListSchema = z.array(z.union([CategoryTreeNodeSchema, CategorySchema]));
const CachedSitemapSchema = z.object({
  categories: z.array(SitemapEntrySchema),
  products: z.array(SitemapEntrySchema),
  articles: z.array(SitemapEntrySchema),
});

function buildPublicCategoriesCacheKey(query: ListCategoriesQuery): string | null {
  if (query.q !== undefined || query.parentId !== undefined) {
    return null;
  }
  const scope = query.rootOnly === true ? 'root' : query.rootOnly === false ? 'sub' : 'all';
  const shape = query.tree === true ? 'tree' : 'flat';
  return `categories:public:${scope}:${shape}`;
}

export interface CatalogService {
  listPublicCategories(
    query: ListCategoriesQuery,
  ): Promise<readonly (PublicCategory | CategoryTreeNode)[]>;
  getPublicCategoryBySlug(slug: string): Promise<CategoryDetail>;
  getSitemap(): Promise<SitemapData>;
  listAdminCategories(
    actor: AuthUser,
    query: ListAdminCategoriesQuery,
  ): Promise<CursorPage<PublicCategory>>;
  getAdminCategoryById(actor: AuthUser, id: string): Promise<CategoryDetail>;
  createCategory(actor: AuthUser, input: CreateCategoryBody): Promise<PublicCategory>;
  updateCategory(actor: AuthUser, id: string, input: UpdateCategoryBody): Promise<PublicCategory>;
  deleteCategory(actor: AuthUser, id: string): Promise<void>;
}

function serializeSpecField(field: SpecFieldDefRow): SpecFieldDef {
  return {
    key: field.key,
    label: field.label,
    ...(field.unit !== undefined ? { unit: field.unit } : {}),
    type: field.type,
    sortOrder: field.sortOrder,
  };
}

export function serializeCategory(row: CategoryWithParentRow): PublicCategory {
  const parent =
    row.parentId !== null && row.parentName !== null && row.parentSlug !== null
      ? { id: row.parentId, name: row.parentName, slug: row.parentSlug }
      : null;

  return {
    id: row.id,
    parentId: row.parentId,
    parent,
    name: row.name,
    slug: row.slug,
    description: row.description,
    metaTitle: row.metaTitle,
    metaDescription: row.metaDescription,
    focusKeyword: row.focusKeyword,
    canonicalUrl: row.canonicalUrl,
    noIndex: row.noIndex,
    ogImageUrl: row.ogImageUrl,
    imageUrl: row.imageUrl,
    bannerImageUrl: row.bannerImageUrl,
    specSchema: row.specSchema.map(serializeSpecField),
    sortOrder: row.sortOrder,
    isActive: isRecordActive(row),
    status: toRecordStatus(row),
    deletedAt: row.deletedAt !== null ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Merges parent `specSchema` with child `specSchema` overrides (keyed by `key`),
 * sorted deterministically by `(sortOrder ASC, key ASC)`.
 */
export function mergeEffectiveSpecSchema(
  parentSpecs: readonly SpecFieldDefRow[],
  ownSpecs: readonly SpecFieldDefRow[],
): SpecFieldDef[] {
  const byKey = new Map<string, SpecFieldDefRow>();
  for (const spec of parentSpecs) {
    byKey.set(spec.key, spec);
  }
  for (const spec of ownSpecs) {
    byKey.set(spec.key, spec);
  }
  return [...byKey.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
    .map(serializeSpecField);
}

export function createCatalogService(
  catalogRepo: CatalogRepository,
  revalidator: RevalidateNotifier = revalidateNotifier,
  cache: ResponseCache = noopCache,
): CatalogService {
  async function validateParentAssignment(
    parentId: string | null | undefined,
    selfId?: string,
  ): Promise<CategoryWithParentRow | null> {
    if (parentId === undefined || parentId === null) {
      return null;
    }

    if (selfId !== undefined && parentId === selfId) {
      throw new ValidationError('A category cannot be its own parent', [
        { field: 'parentId', message: 'parentId must not equal category id' },
      ]);
    }

    const parent = await catalogRepo.findById(parentId);
    if (parent === null || !isRecordActive(parent)) {
      throw new NotFoundError('Parent category not found', 'PARENT_CATEGORY_NOT_FOUND');
    }

    // Enforce maximum hierarchy depth of 2 (root -> subcategory).
    if (parent.parentId !== null) {
      throw new ValidationError('Maximum category nesting depth is 2 levels', [
        { field: 'parentId', message: 'Cannot nest a category under a subcategory' },
      ]);
    }

    if (selfId !== undefined) {
      const hasChildren = await catalogRepo.hasAnyChildren(selfId);
      if (hasChildren) {
        throw new ConflictError(
          'Cannot convert a root category with existing subcategories into a subcategory',
          'CATEGORY_DEPTH_CONFLICT',
        );
      }
    }

    return parent;
  }

  return {
    async listPublicCategories(
      query: ListCategoriesQuery,
    ): Promise<readonly (PublicCategory | CategoryTreeNode)[]> {
      const cacheKey = buildPublicCategoriesCacheKey(query);
      if (cacheKey !== null) {
        const cached = await cache.getJson(cacheKey, CachedCategoryListSchema);
        if (cached !== null) {
          return cached;
        }
      }

      const hasFilter =
        query.q !== undefined || query.parentId !== undefined || query.rootOnly !== undefined;
      const rows = await catalogRepo.listActive(
        hasFilter
          ? {
              ...(query.q !== undefined ? { query: query.q } : {}),
              ...(query.parentId !== undefined ? { parentId: query.parentId } : {}),
              ...(query.rootOnly !== undefined ? { rootOnly: query.rootOnly } : {}),
            }
          : undefined,
      );
      const serialized = rows.map(serializeCategory);

      if (query.tree !== true) {
        if (cacheKey !== null) {
          await cache.setJson(cacheKey, serialized, CATEGORIES_CACHE_TTL_SEC, ['categories']);
        }
        return serialized;
      }

      // If a fuzzy search matched a subcategory without matching its parent, include the active parent so the tree stays intact.
      const byId = new Map(serialized.map((item) => [item.id, item]));
      const missingParentIds =
        query.parentId === undefined && query.rootOnly === undefined
          ? [
              ...new Set(
                serialized
                  .map((item) => item.parentId)
                  .filter((pid): pid is string => pid !== null && !byId.has(pid)),
              ),
            ]
          : [];
      if (missingParentIds.length > 0) {
        const fetchedParents = await catalogRepo.findByIds(missingParentIds);
        for (const parent of fetchedParents) {
          if (isRecordActive(parent)) {
            byId.set(parent.id, serializeCategory(parent));
          }
        }
      }

      const childrenByParent = new Map<string, PublicCategory[]>();
      const roots: PublicCategory[] = [];

      for (const item of byId.values()) {
        if (item.parentId === null) {
          roots.push(item);
        } else {
          const siblings = childrenByParent.get(item.parentId) ?? [];
          siblings.push(item);
          childrenByParent.set(item.parentId, siblings);
        }
      }

      const tree = roots.map((root): CategoryTreeNode => ({
        ...root,
        children: childrenByParent.get(root.id) ?? [],
      }));
      if (cacheKey !== null) {
        await cache.setJson(cacheKey, tree, CATEGORIES_CACHE_TTL_SEC, ['categories']);
      }
      return tree;
    },

    async getPublicCategoryBySlug(slug: string): Promise<CategoryDetail> {
      const category = await catalogRepo.findActiveBySlug(slug);
      if (category === null) {
        throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
      }

      const [parentRow, childRows] = await Promise.all([
        category.parentId !== null
          ? catalogRepo.findById(category.parentId)
          : Promise.resolve(null),
        category.parentId === null
          ? catalogRepo.listActiveChildren(category.id)
          : Promise.resolve([]),
      ]);

      const parentActive = parentRow !== null && isRecordActive(parentRow) ? parentRow : null;
      if (category.parentId !== null && parentActive === null) {
        throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
      }

      const effectiveSpecSchema = mergeEffectiveSpecSchema(
        parentActive?.specSchema ?? [],
        category.specSchema,
      );

      return {
        ...serializeCategory(category),
        parent:
          parentActive !== null
            ? { id: parentActive.id, name: parentActive.name, slug: parentActive.slug }
            : null,
        subCategories: childRows.map(serializeCategory),
        effectiveSpecSchema,
      };
    },

    async getSitemap(): Promise<SitemapData> {
      const cached = await cache.getJson('seo:sitemap', CachedSitemapSchema);
      if (cached !== null) {
        return cached;
      }

      const index = await catalogRepo.listSitemapIndex();
      const data: SitemapData = {
        categories: index.categories.map((row) => ({
          slug: row.slug,
          updatedAt: row.updatedAt.toISOString(),
        })),
        products: index.products.map((row) => ({
          slug: row.slug,
          updatedAt: row.updatedAt.toISOString(),
        })),
        articles: index.articles.map((row) => ({
          slug: row.slug,
          updatedAt: row.updatedAt.toISOString(),
        })),
      };
      await cache.setJson('seo:sitemap', data, SITEMAP_CACHE_TTL_SEC, ['sitemap']);
      return data;
    },

    async listAdminCategories(
      actor: AuthUser,
      query: ListAdminCategoriesQuery,
    ): Promise<CursorPage<PublicCategory>> {
      assertAdminUser(actor);

      const filters = {
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.parentId !== undefined ? { parentId: query.parentId } : {}),
        ...(query.rootOnly !== undefined ? { rootOnly: query.rootOnly } : {}),
      };

      return paginateAdminList({
        query,
        listOffset: ({ limit, offset }) =>
          catalogRepo.listAdminOffset({ limit, offset, ...filters }),
        listCursor: ({ limit, cursor }) =>
          catalogRepo.listAdminCursor({
            limit,
            ...(cursor !== undefined ? { cursor } : {}),
            ...filters,
          }),
        serialize: serializeCategory,
      });
    },

    async getAdminCategoryById(actor: AuthUser, id: string): Promise<CategoryDetail> {
      assertAdminUser(actor);

      const category = await catalogRepo.findById(id);
      if (category === null) {
        throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
      }

      const [parentRow, childRows] = await Promise.all([
        category.parentId !== null
          ? catalogRepo.findById(category.parentId)
          : Promise.resolve(null),
        category.parentId === null
          ? catalogRepo.listActiveChildren(category.id)
          : Promise.resolve([]),
      ]);

      const effectiveSpecSchema = mergeEffectiveSpecSchema(
        parentRow?.specSchema ?? [],
        category.specSchema,
      );

      return {
        ...serializeCategory(category),
        parent:
          parentRow !== null
            ? { id: parentRow.id, name: parentRow.name, slug: parentRow.slug }
            : null,
        subCategories: childRows.map(serializeCategory),
        effectiveSpecSchema,
      };
    },

    async createCategory(actor: AuthUser, input: CreateCategoryBody): Promise<PublicCategory> {
      assertAdminUser(actor);
      const parent = await validateParentAssignment(input.parentId);

      const resolvedActive = resolveActiveStateInput(input) ?? true;
      const resolvedSlug = input.slug ?? slugify(input.name, 140);
      const created = await catalogRepo.create({
        id: generateId(),
        parentId: input.parentId ?? null,
        name: input.name,
        slug: resolvedSlug,
        description: input.description ?? null,
        metaTitle: input.metaTitle ?? null,
        metaDescription: input.metaDescription ?? null,
        focusKeyword: input.focusKeyword ?? null,
        canonicalUrl: input.canonicalUrl ?? null,
        noIndex: input.noIndex,
        ogImageUrl: input.ogImageUrl ?? null,
        imageUrl: input.imageUrl ?? null,
        bannerImageUrl: input.bannerImageUrl ?? null,
        specSchema: input.specSchema,
        sortOrder: input.sortOrder,
        isActive: resolvedActive,
        deletedAt: resolvedActive ? null : new Date(),
      });

      await revalidator.notify(['categories', `category:${created.slug}`, 'sitemap']);
      return serializeCategory({
        ...created,
        parentName: parent?.name ?? null,
        parentSlug: parent?.slug ?? null,
      });
    },

    async updateCategory(
      actor: AuthUser,
      id: string,
      input: UpdateCategoryBody,
    ): Promise<PublicCategory> {
      assertAdminUser(actor);

      const existing = await catalogRepo.findById(id);
      if (existing === null) {
        throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
      }

      const nextActive = resolveActiveStateInput(input);
      const effectiveParentId = input.parentId !== undefined ? input.parentId : existing.parentId;
      const willBeActive = nextActive ?? isRecordActive(existing);
      let validatedParent: CategoryWithParentRow | null | undefined;
      if (
        input.parentId !== undefined ||
        (willBeActive && !isRecordActive(existing) && effectiveParentId !== null)
      ) {
        validatedParent = await validateParentAssignment(effectiveParentId, id);
      }

      if (nextActive === false) {
        const [hasChildren, hasProducts] = await Promise.all([
          catalogRepo.hasNonDeletedChildren(id),
          catalogRepo.hasNonDeletedProducts(id),
        ]);
        if (hasChildren) {
          throw new ConflictError(
            'Cannot deactivate a category that still has active subcategories',
            'CATEGORY_HAS_CHILDREN',
          );
        }
        if (hasProducts) {
          throw new ConflictError(
            'Cannot deactivate a category that still has active assigned products',
            'CATEGORY_HAS_PRODUCTS',
          );
        }
      }

      const activePatch =
        nextActive !== undefined
          ? {
              isActive: nextActive,
              deletedAt: nextActive ? null : (existing.deletedAt ?? new Date()),
            }
          : {};

      const updated = await catalogRepo.updateById(id, {
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.metaTitle !== undefined ? { metaTitle: input.metaTitle } : {}),
        ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
        ...(input.focusKeyword !== undefined ? { focusKeyword: input.focusKeyword } : {}),
        ...(input.canonicalUrl !== undefined ? { canonicalUrl: input.canonicalUrl } : {}),
        ...(input.noIndex !== undefined ? { noIndex: input.noIndex } : {}),
        ...(input.ogImageUrl !== undefined ? { ogImageUrl: input.ogImageUrl } : {}),
        ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
        ...(input.bannerImageUrl !== undefined ? { bannerImageUrl: input.bannerImageUrl } : {}),
        ...(input.specSchema !== undefined ? { specSchema: input.specSchema } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...activePatch,
      });

      if (updated === null) {
        throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
      }

      await revalidator.notify([
        'categories',
        `category:${existing.slug}`,
        `category:${updated.slug}`,
        'sitemap',
      ]);

      return serializeCategory({
        ...updated,
        parentName:
          validatedParent !== undefined ? (validatedParent?.name ?? null) : existing.parentName,
        parentSlug:
          validatedParent !== undefined ? (validatedParent?.slug ?? null) : existing.parentSlug,
      });
    },

    async deleteCategory(actor: AuthUser, id: string): Promise<void> {
      assertAdminUser(actor);

      const existing = await catalogRepo.findById(id);
      if (existing === null) {
        throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
      }

      const [hasChildren, hasProducts] = await Promise.all([
        catalogRepo.hasNonDeletedChildren(id),
        catalogRepo.hasNonDeletedProducts(id),
      ]);
      if (hasChildren) {
        throw new ConflictError(
          'Cannot delete a category that still has subcategories',
          'CATEGORY_HAS_CHILDREN',
        );
      }
      if (hasProducts) {
        throw new ConflictError(
          'Cannot delete a category that still has assigned products',
          'CATEGORY_HAS_PRODUCTS',
        );
      }

      await catalogRepo.softDeleteById(id, existing.deletedAt ?? new Date());
      await revalidator.notify(['categories', `category:${existing.slug}`, 'sitemap']);
    },
  };
}
