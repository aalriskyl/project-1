import { NotFoundError, ValidationError } from '@/lib/errors.ts';
import { generateId } from '@/lib/id.ts';
import {
  assertCursorOrPage,
  buildOffsetPage,
  type CursorPage,
  decodeCursor,
  encodeCursor,
} from '@/lib/pagination.ts';
import { type RevalidateNotifier, revalidateNotifier } from '@/lib/revalidate.ts';
import { assertAdminUser } from '@/middlewares/authorize.ts';
import type { ProductsRepository } from '@/modules/products/products.repository.ts';
import type {
  ProductReviewWithAuthorRow,
  ReviewsRepository,
} from '@/modules/reviews/reviews.repository.ts';
import type {
  CreateProductReviewBody,
  ListAdminReviewsQuery,
  ListProductReviewsQuery,
  ModerateReviewBody,
  PublicProductReview,
} from '@/modules/reviews/reviews.schema.ts';
import type { AuthUser } from '@/types/app.ts';

export interface ReviewsService {
  listProductReviews(
    productId: string,
    query: ListProductReviewsQuery,
  ): Promise<CursorPage<PublicProductReview>>;
  listAdminReviews(
    actor: AuthUser,
    query: ListAdminReviewsQuery,
  ): Promise<CursorPage<PublicProductReview>>;
  createProductReview(
    actor: AuthUser,
    productId: string,
    body: CreateProductReviewBody,
  ): Promise<PublicProductReview>;
  moderateReview(
    actor: AuthUser,
    reviewId: string,
    body: ModerateReviewBody,
  ): Promise<PublicProductReview>;
  deleteReview(actor: AuthUser, reviewId: string): Promise<void>;
}

function serializeReview(row: ProductReviewWithAuthorRow): PublicProductReview {
  return {
    id: row.id,
    productId: row.productId,
    userId: row.userId,
    authorName: row.authorName,
    orderId: row.orderId,
    rating: row.rating,
    comment: row.comment,
    isPublished: row.isPublished,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createReviewsService(
  reviewsRepo: ReviewsRepository,
  productsRepo: ProductsRepository,
  revalidator: RevalidateNotifier = revalidateNotifier,
): ReviewsService {
  return {
    async listProductReviews(
      productId: string,
      query: ListProductReviewsQuery,
    ): Promise<CursorPage<PublicProductReview>> {
      const product = await productsRepo.findById(productId);
      if (product === null || !product.isActive) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      const decodedCursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;
      const rows = await reviewsRepo.listPublishedByProductCursor({
        productId,
        limit: query.limit + 1,
        ...(decodedCursor !== undefined ? { cursor: decodedCursor } : {}),
      });

      const hasMore = rows.length > query.limit;
      const pageItems = hasMore ? rows.slice(0, query.limit) : rows;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor = hasMore && lastItem !== undefined ? encodeCursor(lastItem) : null;

      return {
        data: pageItems.map(serializeReview),
        meta: {
          nextCursor,
          hasMore,
          limit: query.limit,
        },
      };
    },

    async listAdminReviews(
      actor: AuthUser,
      query: ListAdminReviewsQuery,
    ): Promise<CursorPage<PublicProductReview>> {
      assertAdminUser(actor);
      assertCursorOrPage(query);

      if (query.page !== undefined) {
        const offset = (query.page - 1) * query.limit;
        const { items, total } = await reviewsRepo.listAdminOffset({
          limit: query.limit,
          offset,
          ...(query.productId !== undefined ? { productId: query.productId } : {}),
          ...(query.isPublished !== undefined ? { isPublished: query.isPublished } : {}),
          ...(query.rating !== undefined ? { rating: query.rating } : {}),
        });
        return buildOffsetPage(items.map(serializeReview), total, query.page, query.limit);
      }

      const decodedCursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;
      const rows = await reviewsRepo.listAdminCursor({
        limit: query.limit + 1,
        ...(decodedCursor !== undefined ? { cursor: decodedCursor } : {}),
        ...(query.productId !== undefined ? { productId: query.productId } : {}),
        ...(query.isPublished !== undefined ? { isPublished: query.isPublished } : {}),
        ...(query.rating !== undefined ? { rating: query.rating } : {}),
      });

      const hasMore = rows.length > query.limit;
      const pageItems = hasMore ? rows.slice(0, query.limit) : rows;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor = hasMore && lastItem !== undefined ? encodeCursor(lastItem) : null;

      return {
        data: pageItems.map(serializeReview),
        meta: {
          nextCursor,
          hasMore,
          limit: query.limit,
        },
      };
    },

    async createProductReview(
      actor: AuthUser,
      productId: string,
      body: CreateProductReviewBody,
    ): Promise<PublicProductReview> {
      if (body.orderId !== undefined && body.orderId !== null) {
        throw new ValidationError('Purchase verification is not available', [
          {
            field: 'orderId',
            message: 'Order associations must be verified server-side; omit orderId',
          },
        ]);
      }
      const product = await productsRepo.findById(productId);
      if (product === null || !product.isActive) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      const created = await reviewsRepo.createAndSyncProductRating({
        id: generateId(),
        productId,
        userId: actor.id,
        orderId: body.orderId ?? null,
        rating: body.rating,
        comment: body.comment ?? null,
      });

      revalidator.notify(['products', `product:${product.slug}`]);
      return serializeReview(created);
    },

    async moderateReview(
      actor: AuthUser,
      reviewId: string,
      body: ModerateReviewBody,
    ): Promise<PublicProductReview> {
      assertAdminUser(actor);

      const updated = await reviewsRepo.updatePublishStateAndSyncRating(reviewId, body.isPublished);
      if (updated === null) {
        throw new NotFoundError('Review not found', 'REVIEW_NOT_FOUND');
      }

      const product = await productsRepo.findById(updated.productId);
      if (product !== null) {
        revalidator.notify(['products', `product:${product.slug}`]);
      }

      return serializeReview(updated);
    },

    async deleteReview(actor: AuthUser, reviewId: string): Promise<void> {
      assertAdminUser(actor);

      const deleted = await reviewsRepo.deleteAndSyncRating(reviewId);
      if (deleted === null) {
        throw new NotFoundError('Review not found', 'REVIEW_NOT_FOUND');
      }

      const product = await productsRepo.findById(deleted.productId);
      if (product !== null) {
        revalidator.notify(['products', `product:${product.slug}`]);
      }
    },
  };
}
