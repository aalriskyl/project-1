import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import type { Database } from '@/db/client.ts';
import { articles } from '@/db/schema/articles.ts';
import { type CategoryRow, categories, type SpecFieldDefRow } from '@/db/schema/categories.ts';
import { products } from '@/db/schema/products.ts';
import { ConflictError } from '@/lib/errors.ts';

export interface CreateCategoryRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
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
  listActive(): Promise<readonly CategoryRow[]>;
  listAllNonDeleted(): Promise<readonly CategoryRow[]>;
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
  return {
    async listActive(): Promise<readonly CategoryRow[]> {
      return db
        .select()
        .from(categories)
        .where(and(isNull(categories.deletedAt), eq(categories.isActive, true)))
        .orderBy(asc(categories.sortOrder), asc(categories.name), asc(categories.id));
    },

    async listAllNonDeleted(): Promise<readonly CategoryRow[]> {
      return db
        .select()
        .from(categories)
        .where(isNull(categories.deletedAt))
        .orderBy(asc(categories.sortOrder), asc(categories.name), asc(categories.id));
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
        const [created] = await db
          .insert(categories)
          .values({
            id: input.id,
            parentId: input.parentId,
            name: input.name,
            slug: input.slug,
            description: input.description,
            metaTitle: input.metaTitle,
            metaDescription: input.metaDescription,
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
        const [updated] = await db
          .update(categories)
          .set({
            ...patch,
            updatedAt: new Date(),
          })
          .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
          .returning();
        return updated ?? null;
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
      const [deleted] = await db
        .update(categories)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
        .returning({ id: categories.id });
      return deleted !== undefined;
    },

    async listSitemapIndex() {
      const [categoryRows, productRows, articleRows] = await Promise.all([
        db
          .select({ slug: categories.slug, updatedAt: categories.updatedAt })
          .from(categories)
          .where(and(isNull(categories.deletedAt), eq(categories.isActive, true)))
          .orderBy(asc(categories.sortOrder), asc(categories.id)),
        db
          .select({ slug: products.slug, updatedAt: products.updatedAt })
          .from(products)
          .where(and(isNull(products.deletedAt), eq(products.isActive, true)))
          .orderBy(desc(products.createdAt), desc(products.id)),
        db
          .select({ slug: articles.slug, updatedAt: articles.updatedAt })
          .from(articles)
          .where(and(isNull(articles.deletedAt), eq(articles.isPublished, true)))
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
