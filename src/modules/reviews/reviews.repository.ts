import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { productReviews } from '@/db/schema/product-reviews.ts';
import { products } from '@/db/schema/products.ts';
import { users } from '@/db/schema/users.ts';
import {
  activeRecordConditions,
  buildDateRangeConditions,
  buildDescCursorCondition,
  buildStatusFilterConditions,
  isUniqueViolation,
} from '@/lib/shared/db-helpers.ts';
import { ConflictError, NotFoundError } from '@/lib/shared/errors.ts';
import { buildFuzzySearchCondition } from '@/lib/api/search.ts';
import type {
  AdminDateListFilter,
  CursorListParams,
  OffsetListParams,
  OffsetListResult,
  SoftDeletableEntity,
  SoftDeletePatch,
} from '@/types/common.ts';

export interface ProductReviewWithAuthorRow extends SoftDeletableEntity {
  readonly productId: string;
  readonly productName: string;
  readonly productSlug: string;
  readonly userId: string;
  readonly authorName: string;
  readonly orderId: string | null;
  readonly rating: number;
  readonly comment: string | null;
  readonly isPublished: boolean;
}

export interface CreateReviewRecord {
  readonly id: string;
  readonly productId: string;
  readonly userId: string;
  readonly orderId: string | null;
  readonly rating: number;
  readonly comment: string | null;
}

export interface AdminReviewsFilter extends AdminDateListFilter {
  readonly productId?: string;
  readonly userId?: string;
  readonly isPublished?: boolean;
  readonly rating?: number;
}

export interface UpdateReviewModerationPatch extends SoftDeletePatch {
  readonly isPublished?: boolean;
}

export interface ReviewsRepository {
  listPublishedByProductCursor(
    params: CursorListParams & {
      readonly productId: string;
      readonly rating?: number;
    },
  ): Promise<readonly ProductReviewWithAuthorRow[]>;
  listAdminCursor(
    params: AdminReviewsFilter & CursorListParams,
  ): Promise<readonly ProductReviewWithAuthorRow[]>;
  listAdminOffset(
    params: AdminReviewsFilter & OffsetListParams,
  ): Promise<OffsetListResult<ProductReviewWithAuthorRow>>;
  createAndSyncProductRating(input: CreateReviewRecord): Promise<ProductReviewWithAuthorRow>;
  updateOwnReviewAndSyncRating(params: {
    readonly productId: string;
    readonly userId: string;
    readonly rating?: number;
    readonly comment?: string | null;
  }): Promise<ProductReviewWithAuthorRow | null>;
  softDeleteOwnReviewAndSyncRating(params: {
    readonly productId: string;
    readonly userId: string;
  }): Promise<boolean>;
  updatePublishStateAndSyncRating(
    reviewId: string,
    patchOrIsPublished: boolean | UpdateReviewModerationPatch,
  ): Promise<ProductReviewWithAuthorRow | null>;
  deleteAndSyncRating(reviewId: string): Promise<{ readonly productId: string } | null>;
}

export function createReviewsRepository(db: Database): ReviewsRepository {
  const reviewSearchTarget = sql`(coalesce(${productReviews.comment}, '') || ' ' || ${users.displayName})`;

  const selectShape = {
    id: productReviews.id,
    productId: productReviews.productId,
    productName: products.name,
    productSlug: products.slug,
    userId: productReviews.userId,
    authorName: users.displayName,
    orderId: productReviews.orderId,
    rating: productReviews.rating,
    comment: productReviews.comment,
    isPublished: productReviews.isPublished,
    isActive: productReviews.isActive,
    createdAt: productReviews.createdAt,
    updatedAt: productReviews.updatedAt,
    deletedAt: productReviews.deletedAt,
  } satisfies Record<keyof ProductReviewWithAuthorRow, unknown>;

  async function recomputeProductRatingTx(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    productId: string,
  ): Promise<void> {
    const [stats] = await tx
      .select({
        avgRating: sql<string>`coalesce(round(avg(${productReviews.rating})::numeric, 2), 0.00)::text`,
        totalCount: sql<number>`count(*)::int`,
      })
      .from(productReviews)
      .where(
        and(
          eq(productReviews.productId, productId),
          eq(productReviews.isPublished, true),
          ...activeRecordConditions(productReviews),
        ),
      );

    await tx
      .update(products)
      .set({
        ratingAvg: stats?.avgRating ?? '0.00',
        reviewCount: stats?.totalCount ?? 0,
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId));
  }

  function buildAdminFilterConditions(filter: AdminReviewsFilter) {
    const conditions = [
      ...buildStatusFilterConditions(productReviews, filter.status),
      ...buildDateRangeConditions(productReviews.createdAt, filter),
    ];
    if (filter.productId !== undefined) {
      conditions.push(eq(productReviews.productId, filter.productId));
    }
    if (filter.userId !== undefined) {
      conditions.push(eq(productReviews.userId, filter.userId));
    }
    if (filter.isPublished !== undefined) {
      conditions.push(eq(productReviews.isPublished, filter.isPublished));
    }
    if (filter.rating !== undefined) {
      conditions.push(eq(productReviews.rating, filter.rating));
    }
    if (filter.query !== undefined) {
      conditions.push(
        buildFuzzySearchCondition({
          targetSql: reviewSearchTarget,
          query: filter.query,
        }),
      );
    }
    return conditions;
  }

  return {
    async listPublishedByProductCursor({
      productId,
      limit,
      cursor,
      rating,
    }): Promise<readonly ProductReviewWithAuthorRow[]> {
      const conditions = [
        eq(productReviews.productId, productId),
        eq(productReviews.isPublished, true),
        ...activeRecordConditions(productReviews),
      ];

      if (rating !== undefined) {
        conditions.push(eq(productReviews.rating, rating));
      }

      const cursorCond = buildDescCursorCondition(
        productReviews.createdAt,
        productReviews.id,
        cursor,
      );
      if (cursorCond !== undefined) {
        conditions.push(cursorCond);
      }

      return db
        .select(selectShape)
        .from(productReviews)
        .innerJoin(users, eq(productReviews.userId, users.id))
        .innerJoin(products, eq(productReviews.productId, products.id))
        .where(and(...conditions))
        .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
        .limit(limit);
    },

    async listAdminCursor({
      limit,
      cursor,
      productId,
      userId,
      isPublished,
      rating,
      query,
      status,
      createdFrom,
      createdTo,
    }): Promise<readonly ProductReviewWithAuthorRow[]> {
      const conditions = buildAdminFilterConditions({
        ...(productId !== undefined ? { productId } : {}),
        ...(userId !== undefined ? { userId } : {}),
        ...(isPublished !== undefined ? { isPublished } : {}),
        ...(rating !== undefined ? { rating } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(createdFrom !== undefined ? { createdFrom } : {}),
        ...(createdTo !== undefined ? { createdTo } : {}),
      });
      const cursorCond = buildDescCursorCondition(
        productReviews.createdAt,
        productReviews.id,
        cursor,
      );
      if (cursorCond !== undefined) {
        conditions.push(cursorCond);
      }

      return db
        .select(selectShape)
        .from(productReviews)
        .innerJoin(users, eq(productReviews.userId, users.id))
        .innerJoin(products, eq(productReviews.productId, products.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
        .limit(limit);
    },

    async listAdminOffset({
      limit,
      offset,
      productId,
      userId,
      isPublished,
      rating,
      query,
      status,
      createdFrom,
      createdTo,
    }) {
      const conditions = buildAdminFilterConditions({
        ...(productId !== undefined ? { productId } : {}),
        ...(userId !== undefined ? { userId } : {}),
        ...(isPublished !== undefined ? { isPublished } : {}),
        ...(rating !== undefined ? { rating } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(createdFrom !== undefined ? { createdFrom } : {}),
        ...(createdTo !== undefined ? { createdTo } : {}),
      });
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [items, countRows] = await Promise.all([
        db
          .select(selectShape)
          .from(productReviews)
          .innerJoin(users, eq(productReviews.userId, users.id))
          .innerJoin(products, eq(productReviews.productId, products.id))
          .where(whereClause)
          .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
          .limit(limit)
          .offset(offset),
        (query !== undefined
          ? db
              .select({ total: sql<number>`count(*)::int` })
              .from(productReviews)
              .innerJoin(users, eq(productReviews.userId, users.id))
          : db.select({ total: sql<number>`count(*)::int` }).from(productReviews)
        ).where(whereClause),
      ]);

      return { items, total: countRows[0]?.total ?? 0 };
    },

    async createAndSyncProductRating(
      input: CreateReviewRecord,
    ): Promise<ProductReviewWithAuthorRow> {
      try {
        return await db.transaction(async (tx) => {
          const [productRow] = await tx
            .select({
              id: products.id,
              isActive: products.isActive,
              deletedAt: products.deletedAt,
            })
            .from(products)
            .where(eq(products.id, input.productId))
            .for('update');
          if (productRow === undefined || !productRow.isActive || productRow.deletedAt !== null) {
            throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
          }

          await tx.insert(productReviews).values({
            id: input.id,
            productId: input.productId,
            userId: input.userId,
            orderId: input.orderId,
            rating: input.rating,
            comment: input.comment,
            isPublished: true,
            isActive: true,
          });

          await recomputeProductRatingTx(tx, input.productId);

          const [withAuthor] = await tx
            .select(selectShape)
            .from(productReviews)
            .innerJoin(users, eq(productReviews.userId, users.id))
            .innerJoin(products, eq(productReviews.productId, products.id))
            .where(eq(productReviews.id, input.id))
            .limit(1);

          if (withAuthor === undefined) {
            throw new Error('Failed to load created product review');
          }
          return withAuthor;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            'You have already submitted a review for this product',
            'REVIEW_ALREADY_EXISTS',
          );
        }
        throw err;
      }
    },

    async updateOwnReviewAndSyncRating({
      productId,
      userId,
      rating,
      comment,
    }): Promise<ProductReviewWithAuthorRow | null> {
      return db.transaction(async (tx) => {
        const [productRow] = await tx
          .select({
            id: products.id,
            isActive: products.isActive,
            deletedAt: products.deletedAt,
          })
          .from(products)
          .where(eq(products.id, productId))
          .for('update');
        if (productRow === undefined || !productRow.isActive || productRow.deletedAt !== null) {
          throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
        }

        const [updated] = await tx
          .update(productReviews)
          .set({
            ...(rating !== undefined ? { rating } : {}),
            ...(comment !== undefined ? { comment } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(productReviews.productId, productId),
              eq(productReviews.userId, userId),
              isNull(productReviews.orderId),
              eq(productReviews.isActive, true),
              isNull(productReviews.deletedAt),
            ),
          )
          .returning({ id: productReviews.id });

        if (updated === undefined) {
          return null;
        }

        await recomputeProductRatingTx(tx, productId);

        const [withAuthor] = await tx
          .select(selectShape)
          .from(productReviews)
          .innerJoin(users, eq(productReviews.userId, users.id))
          .innerJoin(products, eq(productReviews.productId, products.id))
          .where(eq(productReviews.id, updated.id))
          .limit(1);

        return withAuthor ?? null;
      });
    },

    async softDeleteOwnReviewAndSyncRating({ productId, userId }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [productRow] = await tx
          .select({
            id: products.id,
            isActive: products.isActive,
            deletedAt: products.deletedAt,
          })
          .from(products)
          .where(eq(products.id, productId))
          .for('update');
        if (productRow === undefined || !productRow.isActive || productRow.deletedAt !== null) {
          throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
        }

        const now = new Date();
        const [softDeleted] = await tx
          .update(productReviews)
          .set({
            isActive: false,
            isPublished: false,
            deletedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(productReviews.productId, productId),
              eq(productReviews.userId, userId),
              isNull(productReviews.orderId),
              eq(productReviews.isActive, true),
              isNull(productReviews.deletedAt),
            ),
          )
          .returning({ id: productReviews.id });

        if (softDeleted === undefined) {
          return false;
        }

        await recomputeProductRatingTx(tx, productId);
        return true;
      });
    },

    async updatePublishStateAndSyncRating(
      reviewId: string,
      patchOrIsPublished: boolean | UpdateReviewModerationPatch,
    ): Promise<ProductReviewWithAuthorRow | null> {
      const patch: UpdateReviewModerationPatch =
        typeof patchOrIsPublished === 'boolean'
          ? { isPublished: patchOrIsPublished }
          : patchOrIsPublished;

      try {
        return await db.transaction(async (tx) => {
          const [initial] = await tx
            .select({ productId: productReviews.productId })
            .from(productReviews)
            .where(eq(productReviews.id, reviewId));
          if (initial === undefined) return null;
          await tx
            .select({ id: products.id })
            .from(products)
            .where(eq(products.id, initial.productId))
            .for('update');

          const [target] = await tx
            .select({
              productId: productReviews.productId,
              deletedAt: productReviews.deletedAt,
            })
            .from(productReviews)
            .where(eq(productReviews.id, reviewId));
          if (target === undefined) return null;

          const now = new Date();
          const setPayload: {
            isPublished?: boolean;
            isActive?: boolean;
            deletedAt?: Date | null;
            updatedAt: Date;
          } = {
            updatedAt: now,
            ...(patch.isPublished !== undefined ? { isPublished: patch.isPublished } : {}),
            ...(patch.isActive !== undefined
              ? {
                  isActive: patch.isActive,
                  ...(patch.isActive === false && patch.isPublished === undefined
                    ? { isPublished: false }
                    : {}),
                  deletedAt:
                    patch.deletedAt !== undefined
                      ? patch.deletedAt
                      : patch.isActive
                        ? null
                        : (target.deletedAt ?? now),
                }
              : {}),
          };

          const [updated] = await tx
            .update(productReviews)
            .set(setPayload)
            .where(eq(productReviews.id, reviewId))
            .returning({ id: productReviews.id, productId: productReviews.productId });

          if (updated === undefined) {
            return null;
          }

          await recomputeProductRatingTx(tx, updated.productId);

          const [withAuthor] = await tx
            .select(selectShape)
            .from(productReviews)
            .innerJoin(users, eq(productReviews.userId, users.id))
            .innerJoin(products, eq(productReviews.productId, products.id))
            .where(eq(productReviews.id, reviewId))
            .limit(1);

          return withAuthor ?? null;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            'An active review by this user already exists for this product',
            'REVIEW_ALREADY_EXISTS',
          );
        }
        throw err;
      }
    },

    async deleteAndSyncRating(reviewId: string): Promise<{ readonly productId: string } | null> {
      return db.transaction(async (tx) => {
        const [initial] = await tx
          .select({ productId: productReviews.productId })
          .from(productReviews)
          .where(eq(productReviews.id, reviewId));
        if (initial === undefined) return null;
        await tx
          .select({ id: products.id })
          .from(products)
          .where(eq(products.id, initial.productId))
          .for('update');

        const [target] = await tx
          .select({ productId: productReviews.productId, deletedAt: productReviews.deletedAt })
          .from(productReviews)
          .where(eq(productReviews.id, reviewId));
        if (target === undefined) return null;

        const now = new Date();
        const [softDeleted] = await tx
          .update(productReviews)
          .set({
            isActive: false,
            isPublished: false,
            deletedAt: target.deletedAt ?? now,
            updatedAt: now,
          })
          .where(eq(productReviews.id, reviewId))
          .returning({ productId: productReviews.productId });

        if (softDeleted === undefined) {
          return null;
        }

        await recomputeProductRatingTx(tx, softDeleted.productId);
        return softDeleted;
      });
    },
  };
}
