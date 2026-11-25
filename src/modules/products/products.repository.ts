import { withMediaMutation } from '@/modules/media/media-attachments.repository.ts';
import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, or, type SQL, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { Database } from '@/db/client.ts';
import {
  type ProductMediaItemRow,
  type ProductRow,
  type ProductSpecsMap,
  productSpareparts,
  products,
} from '@/db/schema/products.ts';
import { ConflictError } from '@/lib/errors.ts';
import type { DecodedCursor } from '@/lib/pagination.ts';
import { buildFuzzySearchCondition } from '@/lib/search.ts';
import type { ProductType } from '@/modules/products/products.schema.ts';

export interface ProductCardRow {
  readonly id: string;
  readonly categoryId: string;
  readonly brandSlug: string | null;
  readonly name: string;
  readonly slug: string;
  readonly sku: string | null;
  readonly productType: string;
  readonly priceIdr: number;
  readonly requiresQuote: boolean;
  readonly stock: number;
  readonly isFeatured: boolean;
  readonly isActive: boolean;
  readonly primaryImageUrl: string | null;
  readonly ratingAvg: string;
  readonly reviewCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProductSparepartCardRow extends ProductCardRow {
  readonly note: string | null;
}

export interface ListPublicProductsFilter {
  readonly limit: number;
  readonly cursor?: DecodedCursor;
  readonly categoryIds?: readonly string[];
  readonly brandSlug?: string;
  readonly isFeatured?: boolean;
  readonly productType?: ProductType;
  readonly requiresQuote?: boolean;
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly query?: string;
}

export interface CreateProductRecord {
  readonly id: string;
  readonly categoryId: string;
  readonly brandSlug: string | null;
  readonly name: string;
  readonly slug: string;
  readonly sku: string | null;
  readonly productType: ProductType;
  readonly descriptionMd: string | null;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly focusKeyword: string | null;
  readonly canonicalUrl: string | null;
  readonly noIndex: boolean;
  readonly ogImageUrl: string | null;
  readonly priceIdr: number;
  readonly requiresQuote: boolean;
  readonly stock: number;
  readonly isFeatured: boolean;
  readonly isActive: boolean;
  readonly primaryImageUrl: string | null;
  readonly media: ProductMediaItemRow[];
  readonly specs: ProductSpecsMap;
  readonly lengthCm: string | null;
  readonly widthCm: string | null;
  readonly heightCm: string | null;
  readonly weightKg: string | null;
}

export interface UpdateProductRecord {
  readonly categoryId?: string;
  readonly brandSlug?: string | null;
  readonly name?: string;
  readonly slug?: string;
  readonly sku?: string | null;
  readonly productType?: ProductType;
  readonly descriptionMd?: string | null;
  readonly metaTitle?: string | null;
  readonly metaDescription?: string | null;
  readonly focusKeyword?: string | null;
  readonly canonicalUrl?: string | null;
  readonly noIndex?: boolean;
  readonly ogImageUrl?: string | null;
  readonly priceIdr?: number;
  readonly requiresQuote?: boolean;
  readonly stock?: number;
  readonly isFeatured?: boolean;
  readonly isActive?: boolean;
  readonly primaryImageUrl?: string | null;
  readonly media?: ProductMediaItemRow[];
  readonly specs?: ProductSpecsMap;
  readonly lengthCm?: string | null;
  readonly widthCm?: string | null;
  readonly heightCm?: string | null;
  readonly weightKg?: string | null;
}

export interface ProductsRepository {
  listPublicCursor(filter: ListPublicProductsFilter): Promise<readonly ProductCardRow[]>;
  listAdminCursor(params: {
    readonly limit: number;
    readonly cursor?: DecodedCursor;
    readonly query?: string;
  }): Promise<readonly ProductCardRow[]>;
  listAdminOffset(params: {
    readonly limit: number;
    readonly offset: number;
    readonly query?: string;
  }): Promise<{ readonly items: readonly ProductCardRow[]; readonly total: number }>;
  findActiveBySlug(slug: string): Promise<ProductRow | null>;
  findById(id: string): Promise<ProductRow | null>;
  findActiveByIds(ids: readonly string[]): Promise<readonly ProductRow[]>;
  findActiveBySlugs(slugs: readonly string[]): Promise<readonly ProductRow[]>;
  findActiveCardsByIds(ids: readonly string[]): Promise<readonly ProductCardRow[]>;
  listRecommendations(params: {
    readonly categoryId?: string;
    readonly excludeProductId?: string;
    readonly limit: number;
  }): Promise<readonly ProductCardRow[]>;
  listSparepartsCursor(params: {
    readonly parentProductId: string;
    readonly limit: number;
    readonly cursor?: DecodedCursor;
  }): Promise<readonly ProductSparepartCardRow[]>;
  replaceSpareparts(
    parentProductId: string,
    items: readonly { readonly sparepartProductId: string; readonly note?: string }[],
  ): Promise<readonly ProductSparepartCardRow[]>;
  create(input: CreateProductRecord): Promise<ProductRow>;
  updateById(id: string, patch: UpdateProductRecord): Promise<ProductRow | null>;
  softDeleteById(id: string, deletedAt: Date): Promise<boolean>;
}

function extractPostgresError(err: unknown): postgres.PostgresError | null {
  if (err instanceof postgres.PostgresError) {
    return err;
  }
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    return extractPostgresError(err.cause);
  }
  return null;
}

function mapUniqueViolation(err: unknown): never {
  const pgErr = extractPostgresError(err);
  if (pgErr !== null && pgErr.code === '23505') {
    if (pgErr.constraint_name?.includes('sku')) {
      throw new ConflictError('A product with this SKU already exists', 'SKU_ALREADY_EXISTS');
    }
    throw new ConflictError('A product with this slug already exists', 'SLUG_ALREADY_EXISTS');
  }
  throw err;
}

export function createProductsRepository(db: Database): ProductsRepository {
  const productSearchTarget = sql`(${products.name} || ' ' || coalesce(${products.sku}, '') || ' ' || coalesce(${products.brandSlug}, ''))`;

  const cardColumns = {
    id: products.id,
    categoryId: products.categoryId,
    brandSlug: products.brandSlug,
    name: products.name,
    slug: products.slug,
    sku: products.sku,
    productType: products.productType,
    priceIdr: products.priceIdr,
    requiresQuote: products.requiresQuote,
    stock: products.stock,
    isFeatured: products.isFeatured,
    isActive: products.isActive,
    primaryImageUrl: products.primaryImageUrl,
    ratingAvg: products.ratingAvg,
    reviewCount: products.reviewCount,
    createdAt: products.createdAt,
    updatedAt: products.updatedAt,
  };

  return {
    async listPublicCursor(filter: ListPublicProductsFilter): Promise<readonly ProductCardRow[]> {
      const conditions: SQL[] = [isNull(products.deletedAt), eq(products.isActive, true)];

      if (filter.categoryIds !== undefined) {
        if (filter.categoryIds.length === 0) {
          return [];
        }
        conditions.push(inArray(products.categoryId, [...filter.categoryIds]));
      }
      if (filter.brandSlug !== undefined) {
        conditions.push(eq(products.brandSlug, filter.brandSlug));
      }
      if (filter.isFeatured !== undefined) {
        conditions.push(eq(products.isFeatured, filter.isFeatured));
      }
      if (filter.productType !== undefined) {
        conditions.push(eq(products.productType, filter.productType));
      }
      if (filter.requiresQuote !== undefined) {
        conditions.push(eq(products.requiresQuote, filter.requiresQuote));
      }
      if (filter.minPrice !== undefined) {
        conditions.push(gte(products.priceIdr, filter.minPrice));
      }
      if (filter.maxPrice !== undefined) {
        conditions.push(lte(products.priceIdr, filter.maxPrice));
      }
      if (filter.query !== undefined) {
        conditions.push(
          buildFuzzySearchCondition({
            targetSql: productSearchTarget,
            query: filter.query,
            searchVector: sql`${products.searchVector}`,
          }),
        );
      }
      if (filter.cursor !== undefined) {
        const cursorCond = or(
          lt(products.createdAt, filter.cursor.createdAt),
          and(eq(products.createdAt, filter.cursor.createdAt), lt(products.id, filter.cursor.id)),
        );
        if (cursorCond !== undefined) {
          conditions.push(cursorCond);
        }
      }

      return db
        .select(cardColumns)
        .from(products)
        .where(and(...conditions))
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(filter.limit);
    },

    async listAdminCursor({ limit, cursor, query }): Promise<readonly ProductCardRow[]> {
      const conditions: SQL[] = [isNull(products.deletedAt)];
      if (query !== undefined) {
        conditions.push(
          buildFuzzySearchCondition({
            targetSql: productSearchTarget,
            query,
            searchVector: sql`${products.searchVector}`,
          }),
        );
      }
      if (cursor !== undefined) {
        const cursorCond = or(
          lt(products.createdAt, cursor.createdAt),
          and(eq(products.createdAt, cursor.createdAt), lt(products.id, cursor.id)),
        );
        if (cursorCond !== undefined) {
          conditions.push(cursorCond);
        }
      }

      return db
        .select(cardColumns)
        .from(products)
        .where(and(...conditions))
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(limit);
    },

    async listAdminOffset({ limit, offset, query }) {
      const conditions: SQL[] = [isNull(products.deletedAt)];
      if (query !== undefined) {
        conditions.push(
          buildFuzzySearchCondition({
            targetSql: productSearchTarget,
            query,
            searchVector: sql`${products.searchVector}`,
          }),
        );
      }
      const whereClause = and(...conditions);

      const [items, countRows] = await Promise.all([
        db
          .select(cardColumns)
          .from(products)
          .where(whereClause)
          .orderBy(desc(products.createdAt), desc(products.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(products)
          .where(whereClause),
      ]);

      return { items, total: countRows[0]?.total ?? 0 };
    },

    async findActiveBySlug(slug: string): Promise<ProductRow | null> {
      const [row] = await db
        .select()
        .from(products)
        .where(
          and(eq(products.slug, slug), eq(products.isActive, true), isNull(products.deletedAt)),
        )
        .limit(1);
      return row ?? null;
    },

    async findById(id: string): Promise<ProductRow | null> {
      const [row] = await db
        .select()
        .from(products)
        .where(and(eq(products.id, id), isNull(products.deletedAt)))
        .limit(1);
      return row ?? null;
    },

    async findActiveByIds(ids: readonly string[]): Promise<readonly ProductRow[]> {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(products)
        .where(
          and(
            inArray(products.id, [...ids]),
            eq(products.isActive, true),
            isNull(products.deletedAt),
          ),
        );
    },

    async findActiveBySlugs(slugs: readonly string[]): Promise<readonly ProductRow[]> {
      if (slugs.length === 0) return [];
      return db
        .select()
        .from(products)
        .where(
          and(
            inArray(products.slug, [...slugs]),
            eq(products.isActive, true),
            isNull(products.deletedAt),
          ),
        );
    },

    async findActiveCardsByIds(ids: readonly string[]): Promise<readonly ProductCardRow[]> {
      if (ids.length === 0) return [];
      const rows = await db
        .select(cardColumns)
        .from(products)
        .where(
          and(
            inArray(products.id, [...ids]),
            eq(products.isActive, true),
            isNull(products.deletedAt),
          ),
        );
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.flatMap((id) => {
        const match = byId.get(id);
        return match !== undefined ? [match] : [];
      });
    },

    async listRecommendations({
      categoryId,
      excludeProductId,
      limit,
    }): Promise<readonly ProductCardRow[]> {
      const baseConditions: SQL[] = [isNull(products.deletedAt), eq(products.isActive, true)];
      if (excludeProductId !== undefined) {
        baseConditions.push(ne(products.id, excludeProductId));
      }
      if (categoryId !== undefined) {
        baseConditions.push(eq(products.categoryId, categoryId));
      }

      return db
        .select(cardColumns)
        .from(products)
        .where(and(...baseConditions))
        .orderBy(desc(products.isFeatured), desc(products.createdAt), desc(products.id))
        .limit(limit);
    },

    async listSparepartsCursor({
      parentProductId,
      limit,
      cursor,
    }): Promise<readonly ProductSparepartCardRow[]> {
      const conditions: SQL[] = [
        eq(productSpareparts.parentProductId, parentProductId),
        isNull(products.deletedAt),
        eq(products.isActive, true),
      ];

      if (cursor !== undefined) {
        const cursorCond = or(
          lt(products.createdAt, cursor.createdAt),
          and(eq(products.createdAt, cursor.createdAt), lt(products.id, cursor.id)),
        );
        if (cursorCond !== undefined) {
          conditions.push(cursorCond);
        }
      }

      return db
        .select({
          ...cardColumns,
          note: productSpareparts.note,
        })
        .from(productSpareparts)
        .innerJoin(products, eq(productSpareparts.sparepartProductId, products.id))
        .where(and(...conditions))
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(limit);
    },

    async replaceSpareparts(parentProductId, items): Promise<readonly ProductSparepartCardRow[]> {
      await db.transaction(async (tx) => {
        await tx
          .delete(productSpareparts)
          .where(eq(productSpareparts.parentProductId, parentProductId));

        if (items.length > 0) {
          await tx.insert(productSpareparts).values(
            items.map((item) => ({
              parentProductId,
              sparepartProductId: item.sparepartProductId,
              note: item.note ?? null,
            })),
          );
        }
      });

      return this.listSparepartsCursor({ parentProductId, limit: 50 });
    },

    async create(input: CreateProductRecord): Promise<ProductRow> {
      try {
        return await withMediaMutation(db, 'products', async (tx) => {
          const [created] = await tx
            .insert(products)
            .values({
              id: input.id,
              categoryId: input.categoryId,
              brandSlug: input.brandSlug,
              name: input.name,
              slug: input.slug,
              sku: input.sku,
              productType: input.productType,
              descriptionMd: input.descriptionMd,
              metaTitle: input.metaTitle,
              metaDescription: input.metaDescription,
              focusKeyword: input.focusKeyword,
              canonicalUrl: input.canonicalUrl,
              noIndex: input.noIndex,
              ogImageUrl: input.ogImageUrl,
              priceIdr: input.priceIdr,
              requiresQuote: input.requiresQuote,
              stock: input.stock,
              isFeatured: input.isFeatured,
              isActive: input.isActive,
              primaryImageUrl: input.primaryImageUrl,
              media: input.media,
              specs: input.specs,
              lengthCm: input.lengthCm,
              widthCm: input.widthCm,
              heightCm: input.heightCm,
              weightKg: input.weightKg,
            })
            .returning();

          if (created === undefined) {
            throw new Error('Failed to insert product');
          }
          return created;
        });
      } catch (err) {
        return mapUniqueViolation(err);
      }
    },

    async updateById(id: string, patch: UpdateProductRecord): Promise<ProductRow | null> {
      try {
        return await withMediaMutation(db, 'products', async (tx) => {
          const [updated] = await tx
            .update(products)
            .set({
              ...patch,
              updatedAt: new Date(),
            })
            .where(and(eq(products.id, id), isNull(products.deletedAt)))
            .returning();
          return updated ?? null;
        });
      } catch (err) {
        return mapUniqueViolation(err);
      }
    },

    async softDeleteById(id: string, deletedAt: Date): Promise<boolean> {
      const deleted = await withMediaMutation(db, 'products', async (tx) => {
        const [row] = await tx
          .update(products)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(and(eq(products.id, id), isNull(products.deletedAt)))
          .returning();
        return row ?? null;
      });
      return deleted !== null;
    },
  };
}
