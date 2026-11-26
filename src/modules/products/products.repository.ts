import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import {
  type ProductCustomSpecRow,
  type ProductMediaItemRow,
  type ProductRow,
  type ProductSpecsMap,
  productSpareparts,
  products,
} from '@/db/schema/products.ts';
import {
  activeRecordConditions,
  buildDateRangeConditions,
  buildDescCursorCondition,
  buildStatusFilterConditions,
  extractPostgresError,
} from '@/lib/db-helpers.ts';
import { ConflictError } from '@/lib/errors.ts';
import { buildFuzzySearchCondition, escapeLikePattern } from '@/lib/search.ts';
import { withMediaMutation } from '@/modules/media/media-attachments.repository.ts';
import type {
  ProductSort,
  ProductSpecFilter,
  ProductType,
} from '@/modules/products/products.schema.ts';
import type {
  AdminDateListFilter,
  CursorListParams,
  OffsetListParams,
  OffsetListResult,
  SeoMetadataPatch,
  SeoMetadataRecord,
  SoftDeletableEntity,
  SoftDeletePatch,
} from '@/types/common.ts';

export type ProductSortCursor =
  | { readonly sort: 'newest'; readonly createdAt: Date; readonly id: string }
  | { readonly sort: 'price_asc'; readonly priceIdr: number; readonly id: string }
  | { readonly sort: 'price_desc'; readonly priceIdr: number; readonly id: string }
  | {
      readonly sort: 'rating_desc';
      readonly ratingAvg: string;
      readonly reviewCount: number;
      readonly id: string;
    };

export interface ProductCardRow extends SoftDeletableEntity {
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
  readonly primaryImageUrl: string | null;
  readonly ratingAvg: string;
  readonly reviewCount: number;
}

export interface ProductSparepartCardRow extends ProductCardRow {
  readonly note: string | null;
}

export interface ListPublicProductsFilter {
  readonly limit: number;
  readonly sort?: ProductSort;
  readonly cursor?: ProductSortCursor;
  readonly categoryIds?: readonly string[];
  readonly brandSlugs?: readonly string[];
  readonly isFeatured?: boolean;
  readonly productType?: ProductType;
  readonly requiresQuote?: boolean;
  readonly inStock?: boolean;
  readonly minRating?: number;
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly specFilters?: readonly ProductSpecFilter[];
  readonly query?: string;
}

export interface ListAdminProductsFilter extends AdminDateListFilter {
  readonly categoryId?: string;
  readonly brandSlugs?: readonly string[];
  readonly productType?: ProductType;
  readonly isFeatured?: boolean;
  readonly requiresQuote?: boolean;
  readonly inStock?: boolean;
}

export interface CreateProductRecord extends SeoMetadataRecord {
  readonly id: string;
  readonly categoryId: string;
  readonly brandSlug: string | null;
  readonly name: string;
  readonly slug: string;
  readonly sku: string | null;
  readonly productType: ProductType;
  readonly descriptionMd: string | null;
  readonly priceIdr: number;
  readonly requiresQuote: boolean;
  readonly stock: number;
  readonly isFeatured: boolean;
  readonly isActive: boolean;
  readonly deletedAt?: Date | null;
  readonly primaryImageUrl: string | null;
  readonly media: ProductMediaItemRow[];
  readonly specs: ProductSpecsMap;
  readonly customSpecs: ProductCustomSpecRow[];
  readonly lengthCm: string | null;
  readonly widthCm: string | null;
  readonly heightCm: string | null;
  readonly weightKg: string | null;
}

export interface UpdateProductRecord extends SeoMetadataPatch, SoftDeletePatch {
  readonly categoryId?: string;
  readonly brandSlug?: string | null;
  readonly name?: string;
  readonly slug?: string;
  readonly sku?: string | null;
  readonly productType?: ProductType;
  readonly descriptionMd?: string | null;
  readonly priceIdr?: number;
  readonly requiresQuote?: boolean;
  readonly stock?: number;
  readonly isFeatured?: boolean;
  readonly primaryImageUrl?: string | null;
  readonly media?: ProductMediaItemRow[];
  readonly specs?: ProductSpecsMap;
  readonly customSpecs?: ProductCustomSpecRow[];
  readonly lengthCm?: string | null;
  readonly widthCm?: string | null;
  readonly heightCm?: string | null;
  readonly weightKg?: string | null;
}

export interface ProductsRepository {
  listPublicCursor(filter: ListPublicProductsFilter): Promise<readonly ProductCardRow[]>;
  listAdminCursor(
    params: ListAdminProductsFilter & CursorListParams,
  ): Promise<readonly ProductCardRow[]>;
  listAdminOffset(
    params: ListAdminProductsFilter & OffsetListParams,
  ): Promise<OffsetListResult<ProductCardRow>>;
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
  listSparepartsCursor(
    params: CursorListParams & {
      readonly parentProductId: string;
      readonly query?: string;
    },
  ): Promise<readonly ProductSparepartCardRow[]>;
  replaceSpareparts(
    parentProductId: string,
    items: readonly { readonly sparepartProductId: string; readonly note?: string }[],
  ): Promise<readonly ProductSparepartCardRow[]>;
  create(input: CreateProductRecord): Promise<ProductRow>;
  updateById(id: string, patch: UpdateProductRecord): Promise<ProductRow | null>;
  softDeleteById(id: string, deletedAt: Date): Promise<boolean>;
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
    deletedAt: products.deletedAt,
    primaryImageUrl: products.primaryImageUrl,
    ratingAvg: products.ratingAvg,
    reviewCount: products.reviewCount,
    createdAt: products.createdAt,
    updatedAt: products.updatedAt,
  };

  function buildSpecFilterCondition(specFilter: ProductSpecFilter): SQL {
    const { key } = specFilter;
    if (specFilter.op === 'gt') {
      return sql`(CASE WHEN jsonb_typeof(${products.specs} -> ${key}) = 'number' THEN (${products.specs} ->> ${key})::double precision END) > ${specFilter.value}`;
    }
    if (specFilter.op === 'gte') {
      return sql`(CASE WHEN jsonb_typeof(${products.specs} -> ${key}) = 'number' THEN (${products.specs} ->> ${key})::double precision END) >= ${specFilter.value}`;
    }
    if (specFilter.op === 'lt') {
      return sql`(CASE WHEN jsonb_typeof(${products.specs} -> ${key}) = 'number' THEN (${products.specs} ->> ${key})::double precision END) < ${specFilter.value}`;
    }
    if (specFilter.op === 'lte') {
      return sql`(CASE WHEN jsonb_typeof(${products.specs} -> ${key}) = 'number' THEN (${products.specs} ->> ${key})::double precision END) <= ${specFilter.value}`;
    }
    if (specFilter.op === 'contains') {
      const likeVal = `%${escapeLikePattern(specFilter.value)}%`;
      return sql`(jsonb_typeof(${products.specs} -> ${key}) = 'string' AND (${products.specs} ->> ${key}) ILIKE ${likeVal})`;
    }
    if (typeof specFilter.value === 'boolean') {
      const boolStr = specFilter.value ? 'true' : 'false';
      return sql`(jsonb_typeof(${products.specs} -> ${key}) = 'boolean' AND (${products.specs} ->> ${key}) = ${boolStr})`;
    }
    if (typeof specFilter.value === 'number') {
      const rawLower = String(specFilter.value).toLowerCase();
      return sql`((CASE WHEN jsonb_typeof(${products.specs} -> ${key}) = 'number' THEN (${products.specs} ->> ${key})::double precision END) = ${specFilter.value} OR (jsonb_typeof(${products.specs} -> ${key}) = 'string' AND lower(${products.specs} ->> ${key}) = ${rawLower}))`;
    }
    const rawLower = specFilter.value.toLowerCase();
    return sql`(jsonb_typeof(${products.specs} -> ${key}) = 'string' AND lower(${products.specs} ->> ${key}) = ${rawLower})`;
  }

  function buildAdminFilterConditions(params: ListAdminProductsFilter): SQL[] {
    const conditions: SQL[] = [
      ...buildStatusFilterConditions(products, params.status),
      ...buildDateRangeConditions(products.createdAt, params),
    ];
    if (params.categoryId !== undefined) {
      conditions.push(eq(products.categoryId, params.categoryId));
    }
    if (params.brandSlugs !== undefined && params.brandSlugs.length > 0) {
      if (params.brandSlugs.length === 1 && params.brandSlugs[0] !== undefined) {
        conditions.push(eq(products.brandSlug, params.brandSlugs[0]));
      } else {
        conditions.push(inArray(products.brandSlug, [...params.brandSlugs]));
      }
    }
    if (params.productType !== undefined) {
      conditions.push(eq(products.productType, params.productType));
    }
    if (params.isFeatured !== undefined) {
      conditions.push(eq(products.isFeatured, params.isFeatured));
    }
    if (params.requiresQuote !== undefined) {
      conditions.push(eq(products.requiresQuote, params.requiresQuote));
    }
    if (params.inStock === true) {
      conditions.push(gt(products.stock, 0));
    } else if (params.inStock === false) {
      conditions.push(eq(products.stock, 0));
    }
    if (params.query !== undefined) {
      conditions.push(
        buildFuzzySearchCondition({
          targetSql: productSearchTarget,
          query: params.query,
          searchVector: sql`${products.searchVector}`,
        }),
      );
    }
    return conditions;
  }

  return {
    async listPublicCursor(filter: ListPublicProductsFilter): Promise<readonly ProductCardRow[]> {
      const conditions: SQL[] = activeRecordConditions(products);
      const sort = filter.sort ?? 'newest';

      if (filter.categoryIds !== undefined) {
        if (filter.categoryIds.length === 0) {
          return [];
        }
        conditions.push(inArray(products.categoryId, [...filter.categoryIds]));
      }
      if (filter.brandSlugs !== undefined && filter.brandSlugs.length > 0) {
        if (filter.brandSlugs.length === 1 && filter.brandSlugs[0] !== undefined) {
          conditions.push(eq(products.brandSlug, filter.brandSlugs[0]));
        } else {
          conditions.push(inArray(products.brandSlug, [...filter.brandSlugs]));
        }
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
      if (filter.inStock === true) {
        conditions.push(gt(products.stock, 0));
      } else if (filter.inStock === false) {
        conditions.push(eq(products.stock, 0));
      }
      if (filter.minRating !== undefined) {
        conditions.push(gte(products.ratingAvg, filter.minRating.toFixed(2)));
      }
      if (filter.minPrice !== undefined) {
        conditions.push(gte(products.priceIdr, filter.minPrice));
      }
      if (filter.maxPrice !== undefined) {
        conditions.push(lte(products.priceIdr, filter.maxPrice));
      }
      if (filter.specFilters !== undefined) {
        for (const specFilter of filter.specFilters) {
          conditions.push(buildSpecFilterCondition(specFilter));
        }
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
        let cursorCond: SQL | undefined;
        if (filter.cursor.sort === 'newest') {
          cursorCond = buildDescCursorCondition(products.createdAt, products.id, filter.cursor);
        } else if (filter.cursor.sort === 'price_asc') {
          cursorCond = or(
            gt(products.priceIdr, filter.cursor.priceIdr),
            and(eq(products.priceIdr, filter.cursor.priceIdr), gt(products.id, filter.cursor.id)),
          );
        } else if (filter.cursor.sort === 'price_desc') {
          cursorCond = or(
            lt(products.priceIdr, filter.cursor.priceIdr),
            and(eq(products.priceIdr, filter.cursor.priceIdr), lt(products.id, filter.cursor.id)),
          );
        } else {
          cursorCond = or(
            lt(products.ratingAvg, filter.cursor.ratingAvg),
            and(
              eq(products.ratingAvg, filter.cursor.ratingAvg),
              lt(products.reviewCount, filter.cursor.reviewCount),
            ),
            and(
              eq(products.ratingAvg, filter.cursor.ratingAvg),
              eq(products.reviewCount, filter.cursor.reviewCount),
              lt(products.id, filter.cursor.id),
            ),
          );
        }
        if (cursorCond !== undefined) {
          conditions.push(cursorCond);
        }
      }

      const orderByClauses =
        sort === 'price_asc'
          ? [asc(products.priceIdr), asc(products.id)]
          : sort === 'price_desc'
            ? [desc(products.priceIdr), desc(products.id)]
            : sort === 'rating_desc'
              ? [desc(products.ratingAvg), desc(products.reviewCount), desc(products.id)]
              : [desc(products.createdAt), desc(products.id)];

      return db
        .select(cardColumns)
        .from(products)
        .where(and(...conditions))
        .orderBy(...orderByClauses)
        .limit(filter.limit);
    },

    async listAdminCursor({
      limit,
      cursor,
      query,
      status,
      categoryId,
      brandSlugs,
      productType,
      isFeatured,
      requiresQuote,
      inStock,
      createdFrom,
      createdTo,
    }): Promise<readonly ProductCardRow[]> {
      const conditions = buildAdminFilterConditions({
        ...(query !== undefined ? { query } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
        ...(brandSlugs !== undefined ? { brandSlugs } : {}),
        ...(productType !== undefined ? { productType } : {}),
        ...(isFeatured !== undefined ? { isFeatured } : {}),
        ...(requiresQuote !== undefined ? { requiresQuote } : {}),
        ...(inStock !== undefined ? { inStock } : {}),
        ...(createdFrom !== undefined ? { createdFrom } : {}),
        ...(createdTo !== undefined ? { createdTo } : {}),
      });
      const cursorCond = buildDescCursorCondition(products.createdAt, products.id, cursor);
      if (cursorCond !== undefined) {
        conditions.push(cursorCond);
      }

      return db
        .select(cardColumns)
        .from(products)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(limit);
    },

    async listAdminOffset({
      limit,
      offset,
      query,
      status,
      categoryId,
      brandSlugs,
      productType,
      isFeatured,
      requiresQuote,
      inStock,
      createdFrom,
      createdTo,
    }) {
      const conditions = buildAdminFilterConditions({
        ...(query !== undefined ? { query } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
        ...(brandSlugs !== undefined ? { brandSlugs } : {}),
        ...(productType !== undefined ? { productType } : {}),
        ...(isFeatured !== undefined ? { isFeatured } : {}),
        ...(requiresQuote !== undefined ? { requiresQuote } : {}),
        ...(inStock !== undefined ? { inStock } : {}),
        ...(createdFrom !== undefined ? { createdFrom } : {}),
        ...(createdTo !== undefined ? { createdTo } : {}),
      });
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

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
      const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
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
      query,
    }): Promise<readonly ProductSparepartCardRow[]> {
      const conditions: SQL[] = [
        eq(productSpareparts.parentProductId, parentProductId),
        ...activeRecordConditions(products),
      ];

      if (query !== undefined) {
        conditions.push(
          buildFuzzySearchCondition({
            targetSql: productSearchTarget,
            query,
            searchVector: sql`${products.searchVector}`,
          }),
        );
      }

      const cursorCond = buildDescCursorCondition(products.createdAt, products.id, cursor);
      if (cursorCond !== undefined) {
        conditions.push(cursorCond);
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
              deletedAt: input.deletedAt ?? null,
              primaryImageUrl: input.primaryImageUrl,
              media: input.media,
              specs: input.specs,
              customSpecs: input.customSpecs,
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
            .where(eq(products.id, id))
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
          .set({ isActive: false, deletedAt, updatedAt: deletedAt })
          .where(eq(products.id, id))
          .returning();
        return row ?? null;
      });
      return deleted !== null;
    },
  };
}
