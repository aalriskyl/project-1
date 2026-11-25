import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { Database } from '@/db/client.ts';
import { productReviews } from '@/db/schema/product-reviews.ts';
import { products } from '@/db/schema/products.ts';
import { users } from '@/db/schema/users.ts';
import { ConflictError } from '@/lib/errors.ts';
import type { DecodedCursor } from '@/lib/pagination.ts';

export interface ProductReviewWithAuthorRow {
  readonly id: string;
  readonly productId: string;
  readonly userId: string;
  readonly authorName: string;
  readonly orderId: string | null;
  readonly rating: number;
  readonly comment: string | null;
  readonly isPublished: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateReviewRecord {
  readonly id: string;
  readonly productId: string;
  readonly userId: string;
  readonly orderId: string | null;
  readonly rating: number;
  readonly comment: string | null;
}

export interface AdminReviewsFilter {
  readonly productId?: string;
  readonly isPublished?: boolean;
  readonly rating?: number;
}

export interface ReviewsRepository {
  listPublishedByProductCursor(params: {
    readonly productId: string;
    readonly limit: number;
    readonly cursor?: DecodedCursor;
  }): Promise<readonly ProductReviewWithAuthorRow[]>;
  listAdminCursor(params: {
    readonly limit: number;
    readonly cursor?: DecodedCursor;
    readonly productId?: string;
    readonly isPublished?: boolean;
    readonly rating?: number;
  }): Promise<readonly ProductReviewWithAuthorRow[]>;
  listAdminOffset(params: {
    readonly limit: number;
    readonly offset: number;
    readonly productId?: string;
    readonly isPublished?: boolean;
    readonly rating?: number;
  }): Promise<{ readonly items: readonly ProductReviewWithAuthorRow[]; readonly total: number }>;
  createAndSyncProductRating(input: CreateReviewRecord): Promise<ProductReviewWithAuthorRow>;
  updatePublishStateAndSyncRating(
    reviewId: string,
    isPublished: boolean,
  ): Promise<ProductReviewWithAuthorRow | null>;
  deleteAndSyncRating(reviewId: string): Promise<{ readonly productId: string } | null>;
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

export function createReviewsRepository(db: Database): ReviewsRepository {
  const selectShape = {
    id: productReviews.id,
    productId: productReviews.productId,
    userId: productReviews.userId,
    authorName: users.displayName,
    orderId: productReviews.orderId,
    rating: productReviews.rating,
    comment: productReviews.comment,
    isPublished: productReviews.isPublished,
    createdAt: productReviews.createdAt,
    updatedAt: productReviews.updatedAt,
  };

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
      .where(and(eq(productReviews.productId, productId), eq(productReviews.isPublished, true)));

    await tx
      .update(products)
      .set({
        ratingAvg: stats?.avgRating ?? '0.00',
        reviewCount: stats?.totalCount ?? 0,
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId));
  }

  return {
    async listPublishedByProductCursor({
      productId,
      limit,
      cursor,
    }): Promise<readonly ProductReviewWithAuthorRow[]> {
      const conditions = [
        eq(productReviews.productId, productId),
        eq(productReviews.isPublished, true),
      ];

      if (cursor !== undefined) {
        const cursorCond = or(
          lt(productReviews.createdAt, cursor.createdAt),
          and(eq(productReviews.createdAt, cursor.createdAt), lt(productReviews.id, cursor.id)),
        );
        if (cursorCond !== undefined) {
          conditions.push(cursorCond);
        }
      }

      return db
        .select(selectShape)
        .from(productReviews)
        .innerJoin(users, eq(productReviews.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
        .limit(limit);
    },

    async listAdminCursor({
      limit,
      cursor,
      productId,
      isPublished,
      rating,
    }): Promise<readonly ProductReviewWithAuthorRow[]> {
      const conditions = [];
      if (productId !== undefined) {
        conditions.push(eq(productReviews.productId, productId));
      }
      if (isPublished !== undefined) {
        conditions.push(eq(productReviews.isPublished, isPublished));
      }
      if (rating !== undefined) {
        conditions.push(eq(productReviews.rating, rating));
      }
      if (cursor !== undefined) {
        const cursorCond = or(
          lt(productReviews.createdAt, cursor.createdAt),
          and(eq(productReviews.createdAt, cursor.createdAt), lt(productReviews.id, cursor.id)),
        );
        if (cursorCond !== undefined) {
          conditions.push(cursorCond);
        }
      }

      return db
        .select(selectShape)
        .from(productReviews)
        .innerJoin(users, eq(productReviews.userId, users.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
        .limit(limit);
    },

    async listAdminOffset({ limit, offset, productId, isPublished, rating }) {
      const conditions = [];
      if (productId !== undefined) {
        conditions.push(eq(productReviews.productId, productId));
      }
      if (isPublished !== undefined) {
        conditions.push(eq(productReviews.isPublished, isPublished));
      }
      if (rating !== undefined) {
        conditions.push(eq(productReviews.rating, rating));
      }
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [items, countRows] = await Promise.all([
        db
          .select(selectShape)
          .from(productReviews)
          .innerJoin(users, eq(productReviews.userId, users.id))
          .where(whereClause)
          .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(productReviews)
          .where(whereClause),
      ]);

      return { items, total: countRows[0]?.total ?? 0 };
    },

    async createAndSyncProductRating(
      input: CreateReviewRecord,
    ): Promise<ProductReviewWithAuthorRow> {
      try {
        return await db.transaction(async (tx) => {
          await tx
            .select({ id: products.id })
            .from(products)
            .where(eq(products.id, input.productId))
            .for('update');
          await tx.insert(productReviews).values({
            id: input.id,
            productId: input.productId,
            userId: input.userId,
            orderId: input.orderId,
            rating: input.rating,
            comment: input.comment,
            isPublished: true,
          });

          await recomputeProductRatingTx(tx, input.productId);

          const [withAuthor] = await tx
            .select(selectShape)
            .from(productReviews)
            .innerJoin(users, eq(productReviews.userId, users.id))
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

    async updatePublishStateAndSyncRating(
      reviewId: string,
      isPublished: boolean,
    ): Promise<ProductReviewWithAuthorRow | null> {
      return db.transaction(async (tx) => {
        const [target] = await tx
          .select({ productId: productReviews.productId })
          .from(productReviews)
          .where(eq(productReviews.id, reviewId));
        if (target === undefined) return null;
        await tx
          .select({ id: products.id })
          .from(products)
          .where(eq(products.id, target.productId))
          .for('update');
        const [updated] = await tx
          .update(productReviews)
          .set({ isPublished, updatedAt: new Date() })
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
          .where(eq(productReviews.id, reviewId))
          .limit(1);

        return withAuthor ?? null;
      });
    },

    async deleteAndSyncRating(reviewId: string): Promise<{ readonly productId: string } | null> {
      return db.transaction(async (tx) => {
        const [target] = await tx
          .select({ productId: productReviews.productId })
          .from(productReviews)
          .where(eq(productReviews.id, reviewId));
        if (target === undefined) return null;
        await tx
          .select({ id: products.id })
          .from(products)
          .where(eq(products.id, target.productId))
          .for('update');
        const [deleted] = await tx
          .delete(productReviews)
          .where(eq(productReviews.id, reviewId))
          .returning({ productId: productReviews.productId });

        if (deleted === undefined) {
          return null;
        }

        await recomputeProductRatingTx(tx, deleted.productId);
        return deleted;
      });
    },
  };
}
