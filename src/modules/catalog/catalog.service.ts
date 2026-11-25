import type { CategoryRow, SpecFieldDefRow } from '@/db/schema/categories.ts';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors.ts';
import { generateId } from '@/lib/id.ts';
import {
  assertCursorOrPage,
  buildOffsetPage,
  type CursorPage,
  decodeCursor,
  encodeCursor,
} from '@/lib/pagination.ts';
import { type RevalidateNotifier, revalidateNotifier } from '@/lib/revalidate.ts';
import { slugify } from '@/lib/slug.ts';
import { assertAdminUser } from '@/middlewares/authorize.ts';
import type { CatalogRepository } from '@/modules/catalog/catalog.repository.ts';
import type {
  CategoryDetail,
  CategoryTreeNode,
  CreateCategoryBody,
  ListAdminCategoriesQuery,
  ListCategoriesQuery,
  PublicCategory,
  SitemapData,
  SpecFieldDef,
  UpdateCategoryBody,
} from '@/modules/catalog/catalog.schema.ts';
import type { AuthUser } from '@/types/app.ts';

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

export function serializeCategory(row: CategoryRow): PublicCategory {
  return {
    id: row.id,
    parentId: row.parentId,
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
    isActive: row.isActive,
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
): CatalogService {
  async function validateParentAssignment(
    parentId: string | null | undefined,
    selfId?: string,
  ): Promise<void> {
    if (parentId === undefined || parentId === null) {
      return;
    }

    if (selfId !== undefined && parentId === selfId) {
      throw new ValidationError('A category cannot be its own parent', [
        { field: 'parentId', message: 'parentId must not equal category id' },
      ]);
    }

    const parent = await catalogRepo.findById(parentId);
    if (parent === null) {
      throw new NotFoundError('Parent category not found', 'PARENT_CATEGORY_NOT_FOUND');
    }

    // Enforce maximum hierarchy depth of 2 (root -> subcategory).
    if (parent.parentId !== null) {
      throw new ValidationError('Maximum category nesting depth is 2 levels', [
        { field: 'parentId', message: 'Cannot nest a category under a subcategory' },
      ]);
    }

    if (selfId !== undefined) {
      const hasChildren = await catalogRepo.hasNonDeletedChildren(selfId);
      if (hasChildren) {
        throw new ConflictError(
          'Cannot convert a root category with existing subcategories into a subcategory',
          'CATEGORY_DEPTH_CONFLICT',
        );
      }
    }
  }

  return {
    async listPublicCategories(
      query: ListCategoriesQuery,
    ): Promise<readonly (PublicCategory | CategoryTreeNode)[]> {
      const rows = await catalogRepo.listActive(
        query.q !== undefined ? { query: query.q } : undefined,
      );
      const serialized = rows.map(serializeCategory);

      if (query.tree !== true) {
        return serialized;
      }

      // If a fuzzy search matched a subcategory without matching its parent, include the active parent so the tree stays intact.
      const byId = new Map(serialized.map((item) => [item.id, item]));
      const missingParentIds = [
        ...new Set(
          serialized
            .map((item) => item.parentId)
            .filter((pid): pid is string => pid !== null && !byId.has(pid)),
        ),
      ];
      if (missingParentIds.length > 0) {
        const fetchedParents = await Promise.all(
          missingParentIds.map((pid) => catalogRepo.findById(pid)),
        );
        for (const parent of fetchedParents) {
          if (parent !== null && parent.isActive) {
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

      return roots.map((root): CategoryTreeNode => ({
        ...root,
        children: childrenByParent.get(root.id) ?? [],
      }));
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

      const parentActive = parentRow !== null && parentRow.isActive ? parentRow : null;
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
      const index = await catalogRepo.listSitemapIndex();
      return {
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
    },

    async listAdminCategories(
      actor: AuthUser,
      query: ListAdminCategoriesQuery,
    ): Promise<CursorPage<PublicCategory>> {
      assertAdminUser(actor);
      assertCursorOrPage(query);

      if (query.page !== undefined) {
        const offset = (query.page - 1) * query.limit;
        const { items, total } = await catalogRepo.listAdminOffset({
          limit: query.limit,
          offset,
          ...(query.q !== undefined ? { query: query.q } : {}),
        });
        return buildOffsetPage(items.map(serializeCategory), total, query.page, query.limit);
      }

      const decodedCursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;
      const rows = await catalogRepo.listAdminCursor({
        limit: query.limit + 1,
        ...(decodedCursor !== undefined ? { cursor: decodedCursor } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });

      const hasMore = rows.length > query.limit;
      const pageItems = hasMore ? rows.slice(0, query.limit) : rows;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor = hasMore && lastItem !== undefined ? encodeCursor(lastItem) : null;

      return {
        data: pageItems.map(serializeCategory),
        meta: {
          nextCursor,
          hasMore,
          limit: query.limit,
        },
      };
    },

    async createCategory(actor: AuthUser, input: CreateCategoryBody): Promise<PublicCategory> {
      assertAdminUser(actor);
      await validateParentAssignment(input.parentId);

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
        isActive: input.isActive,
      });

      revalidator.notify(['categories', `category:${created.slug}`, 'sitemap']);
      return serializeCategory(created);
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

      if (input.parentId !== undefined) {
        await validateParentAssignment(input.parentId, id);
      }

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
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      });

      if (updated === null) {
        throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
      }

      revalidator.notify([
        'categories',
        `category:${existing.slug}`,
        `category:${updated.slug}`,
        'sitemap',
      ]);

      return serializeCategory(updated);
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

      await catalogRepo.softDeleteById(id, new Date());
      revalidator.notify(['categories', `category:${existing.slug}`, 'sitemap']);
    },
  };
}
