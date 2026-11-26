import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '@/db/client.ts';
import { articles } from '@/db/schema/articles.ts';
import { type CategoryRow, categories, type SpecFieldDefRow } from '@/db/schema/categories.ts';
import { products } from '@/db/schema/products.ts';
import {
  activeRecordConditions,
  buildDescCursorCondition,
  buildStatusFilterConditions,
  isUniqueViolation,
} from '@/lib/db-helpers.ts';
import { ConflictError } from '@/lib/errors.ts';
import { buildFuzzyRelevanceScoreSql, buildFuzzySearchCondition } from '@/lib/search.ts';
import { withMediaMutation } from '@/modules/media/media-attachments.repository.ts';
import type {
  AdminListFilter,
  CursorListParams,
  OffsetListParams,
  OffsetListResult,
  SeoMetadataPatch,
  SeoMetadataRecord,
  SoftDeletePatch,
} from '@/types/common.ts';

export interface CreateCategoryRecord extends SeoMetadataRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly bannerImageUrl: string | null;
  readonly specSchema: SpecFieldDefRow[];
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly deletedAt?: Date | null;
}

export interface UpdateCategoryRecord extends SeoMetadataPatch, SoftDeletePatch {
  readonly parentId?: string | null;
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly imageUrl?: string | null;
  readonly bannerImageUrl?: string | null;
  readonly specSchema?: SpecFieldDefRow[];
  readonly sortOrder?: number;
}

export interface AdminCategoriesFilter extends AdminListFilter {
  readonly parentId?: string;
  readonly rootOnly?: boolean;
}

export interface SitemapRow {
  readonly slug: string;
  readonly updatedAt: Date;
}

export interface CategoryWithParentRow extends CategoryRow {
  readonly parentName: string | null;
  readonly parentSlug: string | null;
}

export interface CatalogRepository {
  listActive(filter?: {
    readonly query?: string;
    readonly parentId?: string;
    readonly rootOnly?: boolean;
  }): Promise<readonly CategoryWithParentRow[]>;
  listAdminCursor(
    params: AdminCategoriesFilter & CursorListParams,
  ): Promise<readonly CategoryWithParentRow[]>;
  listAdminOffset(
    params: AdminCategoriesFilter & OffsetListParams,
  ): Promise<OffsetListResult<CategoryWithParentRow>>;
  findById(id: string): Promise<CategoryWithParentRow | null>;
  findByIds(ids: readonly string[]): Promise<readonly CategoryWithParentRow[]>;
  findActiveBySlug(slug: string): Promise<CategoryWithParentRow | null>;
  listActiveChildren(parentId: string): Promise<readonly CategoryWithParentRow[]>;
  hasNonDeletedChildren(parentId: string): Promise<boolean>;
  hasAnyChildren(parentId: string): Promise<boolean>;
  hasNonDeletedProducts(categoryId: string): Promise<boolean>;
  create(input: CreateCategoryRecord): Promise<CategoryRow>;
  updateById(id: string, patch: UpdateCategoryRecord): Promise<CategoryRow | null>;
  softDeleteById(id: string, deletedAt: Date): Promise<boolean>;
  listSitemapIndex(): Promise<{
    readonly categories: readonly SitemapRow[];
    readonly products: readonly SitemapRow[];
    readonly articles: readonly SitemapRow[];
  }>;
}

export function createCatalogRepository(db: Database): CatalogRepository {
  const parentCategory = alias(categories, 'parent_category');
  const categorySearchTarget = sql`(${categories.name} || ' ' || ${categories.slug} || ' ' || coalesce(${categories.description}, ''))`;

  const categoryWithParentColumns = {
    id: categories.id,
    parentId: categories.parentId,
    name: categories.name,
    slug: categories.slug,
    description: categories.description,
    metaTitle: categories.metaTitle,
    metaDescription: categories.metaDescription,
    focusKeyword: categories.focusKeyword,
    canonicalUrl: categories.canonicalUrl,
    noIndex: categories.noIndex,
    ogImageUrl: categories.ogImageUrl,
    imageUrl: categories.imageUrl,
    bannerImageUrl: categories.bannerImageUrl,
    specSchema: categories.specSchema,
    sortOrder: categories.sortOrder,
    isActive: categories.isActive,
    createdAt: categories.createdAt,
    updatedAt: categories.updatedAt,
    deletedAt: categories.deletedAt,
    parentName: parentCategory.name,
    parentSlug: parentCategory.slug,
  } satisfies Record<keyof CategoryWithParentRow, unknown>;

  function buildAdminFilterConditions(params: AdminCategoriesFilter): SQL[] {
    const conditions: SQL[] = buildStatusFilterConditions(categories, params.status);
    if (params.parentId !== undefined) {
      conditions.push(eq(categories.parentId, params.parentId));
    } else if (params.rootOnly === true) {
      conditions.push(isNull(categories.parentId));
    } else if (params.rootOnly === false) {
      conditions.push(isNotNull(categories.parentId));
    }
    if (params.query !== undefined) {
      conditions.push(
        buildFuzzySearchCondition({ targetSql: categorySearchTarget, query: params.query }),
      );
    }
    return conditions;
  }

  return {
    async listActive(filter?: {
      readonly query?: string;
      readonly parentId?: string;
      readonly rootOnly?: boolean;
    }): Promise<readonly CategoryWithParentRow[]> {
      const conditions: SQL[] = activeRecordConditions(categories);
      if (filter?.parentId !== undefined) {
        conditions.push(eq(categories.parentId, filter.parentId));
      } else if (filter?.rootOnly === true) {
        conditions.push(isNull(categories.parentId));
      } else if (filter?.rootOnly === false) {
        conditions.push(isNotNull(categories.parentId));
      }
      if (filter?.query !== undefined) {
        conditions.push(
          buildFuzzySearchCondition({ targetSql: categorySearchTarget, query: filter.query }),
        );
      }

      return db
        .select(categoryWithParentColumns)
        .from(categories)
        .leftJoin(parentCategory, eq(categories.parentId, parentCategory.id))
        .where(and(...conditions))
        .orderBy(
          ...(filter?.query !== undefined
            ? [desc(buildFuzzyRelevanceScoreSql(categorySearchTarget, filter.query))]
            : []),
          asc(categories.sortOrder),
          asc(categories.name),
          asc(categories.id),
        );
    },

    async listAdminCursor({
      limit,
      cursor,
      query,
      status,
      parentId,
      rootOnly,
    }): Promise<readonly CategoryWithParentRow[]> {
      const conditions = buildAdminFilterConditions({
        ...(query !== undefined ? { query } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(rootOnly !== undefined ? { rootOnly } : {}),
      });
      const cursorCond = buildDescCursorCondition(categories.createdAt, categories.id, cursor);
      if (cursorCond !== undefined) {
        conditions.push(cursorCond);
      }

      return db
        .select(categoryWithParentColumns)
        .from(categories)
        .leftJoin(parentCategory, eq(categories.parentId, parentCategory.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(categories.createdAt), desc(categories.id))
        .limit(limit);
    },

    async listAdminOffset({ limit, offset, query, status, parentId, rootOnly }) {
      const conditions = buildAdminFilterConditions({
        ...(query !== undefined ? { query } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(rootOnly !== undefined ? { rootOnly } : {}),
      });
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [items, countRows] = await Promise.all([
        db
          .select(categoryWithParentColumns)
          .from(categories)
          .leftJoin(parentCategory, eq(categories.parentId, parentCategory.id))
          .where(whereClause)
          .orderBy(desc(categories.createdAt), desc(categories.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(categories)
          .where(whereClause),
      ]);

      return { items, total: countRows[0]?.total ?? 0 };
    },

    async findById(id: string): Promise<CategoryWithParentRow | null> {
      const [row] = await db
        .select(categoryWithParentColumns)
        .from(categories)
        .leftJoin(parentCategory, eq(categories.parentId, parentCategory.id))
        .where(eq(categories.id, id))
        .limit(1);
      return row ?? null;
    },

    async findByIds(ids: readonly string[]): Promise<readonly CategoryWithParentRow[]> {
      if (ids.length === 0) {
        return [];
      }
      return db
        .select(categoryWithParentColumns)
        .from(categories)
        .leftJoin(parentCategory, eq(categories.parentId, parentCategory.id))
        .where(inArray(categories.id, [...ids]));
    },

    async findActiveBySlug(slug: string): Promise<CategoryWithParentRow | null> {
      const [row] = await db
        .select(categoryWithParentColumns)
        .from(categories)
        .leftJoin(parentCategory, eq(categories.parentId, parentCategory.id))
        .where(
          and(
            eq(categories.slug, slug),
            eq(categories.isActive, true),
            isNull(categories.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listActiveChildren(parentId: string): Promise<readonly CategoryWithParentRow[]> {
      return db
        .select(categoryWithParentColumns)
        .from(categories)
        .leftJoin(parentCategory, eq(categories.parentId, parentCategory.id))
        .where(
          and(
            eq(categories.parentId, parentId),
            eq(categories.isActive, true),
            isNull(categories.deletedAt),
          ),
        )
        .orderBy(asc(categories.sortOrder), asc(categories.name), asc(categories.id));
    },

    async hasNonDeletedChildren(parentId: string): Promise<boolean> {
      const [child] = await db
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(
            eq(categories.parentId, parentId),
            eq(categories.isActive, true),
            isNull(categories.deletedAt),
          ),
        )
        .limit(1);
      return child !== undefined;
    },

    async hasAnyChildren(parentId: string): Promise<boolean> {
      const [child] = await db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.parentId, parentId))
        .limit(1);
      return child !== undefined;
    },

    async hasNonDeletedProducts(categoryId: string): Promise<boolean> {
      const [product] = await db
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.categoryId, categoryId),
            eq(products.isActive, true),
            isNull(products.deletedAt),
          ),
        )
        .limit(1);
      return product !== undefined;
    },

    async create(input: CreateCategoryRecord): Promise<CategoryRow> {
      try {
        return await withMediaMutation(db, 'categories', async (tx) => {
          const [created] = await tx
            .insert(categories)
            .values({
              id: input.id,
              parentId: input.parentId,
              name: input.name,
              slug: input.slug,
              description: input.description,
              metaTitle: input.metaTitle,
              metaDescription: input.metaDescription,
              focusKeyword: input.focusKeyword,
              canonicalUrl: input.canonicalUrl,
              noIndex: input.noIndex,
              ogImageUrl: input.ogImageUrl,
              imageUrl: input.imageUrl,
              bannerImageUrl: input.bannerImageUrl,
              specSchema: input.specSchema,
              sortOrder: input.sortOrder,
              isActive: input.isActive,
              deletedAt: input.deletedAt ?? null,
            })
            .returning();

          if (created === undefined) {
            throw new Error('Failed to insert category');
          }
          return created;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            'A category with this slug already exists',
            'SLUG_ALREADY_EXISTS',
          );
        }
        throw err;
      }
    },

    async updateById(id: string, patch: UpdateCategoryRecord): Promise<CategoryRow | null> {
      try {
        return await withMediaMutation(db, 'categories', async (tx) => {
          const [updated] = await tx
            .update(categories)
            .set({
              ...patch,
              updatedAt: new Date(),
            })
            .where(eq(categories.id, id))
            .returning();
          return updated ?? null;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            'A category with this slug already exists',
            'SLUG_ALREADY_EXISTS',
          );
        }
        throw err;
      }
    },

    async softDeleteById(id: string, deletedAt: Date): Promise<boolean> {
      const deleted = await withMediaMutation(db, 'categories', async (tx) => {
        const [row] = await tx
          .update(categories)
          .set({ isActive: false, deletedAt, updatedAt: new Date() })
          .where(eq(categories.id, id))
          .returning();
        return row ?? null;
      });
      return deleted !== null;
    },

    async listSitemapIndex() {
      const [categoryRows, productRows, articleRows] = await Promise.all([
        db
          .select({ slug: categories.slug, updatedAt: categories.updatedAt })
          .from(categories)
          .where(
            and(
              isNull(categories.deletedAt),
              eq(categories.isActive, true),
              eq(categories.noIndex, false),
            ),
          )
          .orderBy(asc(categories.sortOrder), asc(categories.id)),
        db
          .select({ slug: products.slug, updatedAt: products.updatedAt })
          .from(products)
          .where(
            and(
              isNull(products.deletedAt),
              eq(products.isActive, true),
              eq(products.noIndex, false),
            ),
          )
          .orderBy(desc(products.createdAt), desc(products.id)),
        db
          .select({ slug: articles.slug, updatedAt: articles.updatedAt })
          .from(articles)
          .where(
            and(
              isNull(articles.deletedAt),
              eq(articles.isActive, true),
              eq(articles.isPublished, true),
              eq(articles.noIndex, false),
            ),
          )
          .orderBy(desc(articles.publishedAt), desc(articles.id)),
      ]);

      return {
        categories: categoryRows,
        products: productRows,
        articles: articleRows,
      };
    },
  };
}
