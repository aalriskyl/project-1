import { withMediaMutation } from '@/modules/media/media-attachments.repository.ts';
import { and, asc, desc, eq, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { Database } from '@/db/client.ts';
import { articles } from '@/db/schema/articles.ts';
import { type CategoryRow, categories, type SpecFieldDefRow } from '@/db/schema/categories.ts';
import { products } from '@/db/schema/products.ts';
import { ConflictError } from '@/lib/errors.ts';
import type { DecodedCursor } from '@/lib/pagination.ts';
import { buildFuzzyRelevanceScoreSql, buildFuzzySearchCondition } from '@/lib/search.ts';

export interface CreateCategoryRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly focusKeyword: string | null;
  readonly canonicalUrl: string | null;
  readonly noIndex: boolean;
  readonly ogImageUrl: string | null;
  readonly imageUrl: string | null;
  readonly bannerImageUrl: string | null;
  readonly specSchema: SpecFieldDefRow[];
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface UpdateCategoryRecord {
  readonly parentId?: string | null;
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly metaTitle?: string | null;
  readonly metaDescription?: string | null;
  readonly focusKeyword?: string | null;
  readonly canonicalUrl?: string | null;
  readonly noIndex?: boolean;
  readonly ogImageUrl?: string | null;
  readonly imageUrl?: string | null;
  readonly bannerImageUrl?: string | null;
  readonly specSchema?: SpecFieldDefRow[];
  readonly sortOrder?: number;
  readonly isActive?: boolean;
}

export interface SitemapRow {
  readonly slug: string;
  readonly updatedAt: Date;
}

export interface CatalogRepository {
  listActive(filter?: { readonly query?: string }): Promise<readonly CategoryRow[]>;
  listAdminCursor(params: {
    readonly limit: number;
    readonly cursor?: DecodedCursor;
    readonly query?: string;
  }): Promise<readonly CategoryRow[]>;
  listAdminOffset(params: {
    readonly limit: number;
    readonly offset: number;
    readonly query?: string;
  }): Promise<{ readonly items: readonly CategoryRow[]; readonly total: number }>;
  findById(id: string): Promise<CategoryRow | null>;
  findActiveBySlug(slug: string): Promise<CategoryRow | null>;
  listActiveChildren(parentId: string): Promise<readonly CategoryRow[]>;
  hasNonDeletedChildren(parentId: string): Promise<boolean>;
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

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof postgres.PostgresError && err.code === '23505') {
    return true;
  }
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    return isUniqueViolation(err.cause);
  }
  return false;
}

export function createCatalogRepository(db: Database): CatalogRepository {
  const categorySearchTarget = sql`(${categories.name} || ' ' || ${categories.slug} || ' ' || coalesce(${categories.description}, ''))`;

  return {
    async listActive(filter?: { readonly query?: string }): Promise<readonly CategoryRow[]> {
      const conditions: SQL[] = [isNull(categories.deletedAt), eq(categories.isActive, true)];
      if (filter?.query !== undefined) {
        conditions.push(
          buildFuzzySearchCondition({ targetSql: categorySearchTarget, query: filter.query }),
        );
      }

      return db
        .select()
        .from(categories)
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

    async listAdminCursor({ limit, cursor, query }): Promise<readonly CategoryRow[]> {
      const conditions: SQL[] = [isNull(categories.deletedAt)];
      if (query !== undefined) {
        conditions.push(buildFuzzySearchCondition({ targetSql: categorySearchTarget, query }));
      }
      if (cursor !== undefined) {
        const cursorCond = or(
          lt(categories.createdAt, cursor.createdAt),
          and(eq(categories.createdAt, cursor.createdAt), lt(categories.id, cursor.id)),
        );
        if (cursorCond !== undefined) {
          conditions.push(cursorCond);
        }
      }

      return db
        .select()
        .from(categories)
        .where(and(...conditions))
        .orderBy(desc(categories.createdAt), desc(categories.id))
        .limit(limit);
    },

    async listAdminOffset({ limit, offset, query }) {
      const conditions: SQL[] = [isNull(categories.deletedAt)];
      if (query !== undefined) {
        conditions.push(buildFuzzySearchCondition({ targetSql: categorySearchTarget, query }));
      }
      const whereClause = and(...conditions);

      const [items, countRows] = await Promise.all([
        db
          .select()
          .from(categories)
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

    async findById(id: string): Promise<CategoryRow | null> {
      const [row] = await db
        .select()
        .from(categories)
        .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
        .limit(1);
      return row ?? null;
    },

    async findActiveBySlug(slug: string): Promise<CategoryRow | null> {
      const [row] = await db
        .select()
        .from(categories)
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

    async listActiveChildren(parentId: string): Promise<readonly CategoryRow[]> {
      return db
        .select()
        .from(categories)
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
        .where(and(eq(categories.parentId, parentId), isNull(categories.deletedAt)))
        .limit(1);
      return child !== undefined;
    },

    async hasNonDeletedProducts(categoryId: string): Promise<boolean> {
      const [product] = await db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.categoryId, categoryId), isNull(products.deletedAt)))
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
            .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
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
          .set({ deletedAt, updatedAt: deletedAt })
          .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
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
