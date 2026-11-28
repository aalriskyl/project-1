import { NotFoundError, ValidationError } from '@/lib/shared/errors.ts';
import { sanitizeMarkdown } from '@/lib/shared/markdown.ts';
import { generateId } from '@/lib/auth/id.ts';
import {
  buildCursorPage,
  type CursorPage,
  decodeCursor,
  paginateAdminList,
} from '@/lib/api/pagination.ts';
import { type RevalidateNotifier, revalidateNotifier } from '@/lib/integrations/revalidate.ts';
import { isRecordActive, resolveActiveStateInput, toRecordStatus } from '@/lib/api/status.ts';
import { assertAdminUser } from '@/middlewares/auth/authorize.ts';
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
  UpdateOwnReviewBody,
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
  updateOwnProductReview(
    actor: AuthUser,
    productId: string,
    body: UpdateOwnReviewBody,
  ): Promise<PublicProductReview>;
  deleteOwnProductReview(actor: AuthUser, productId: string): Promise<void>;
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
    product: {
      id: row.productId,
      name: row.productName,
      slug: row.productSlug,
    },
    userId: row.userId,
    authorName: row.authorName,
    author: {
      id: row.userId,
      name: row.authorName,
    },
    orderId: row.orderId,
    rating: row.rating,
    comment: row.comment,
    isPublished: row.isPublished,
    isActive: isRecordActive(row),
    status: toRecordStatus(row),
    deletedAt: row.deletedAt !== null ? row.deletedAt.toISOString() : null,
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
      if (product === null || !isRecordActive(product)) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      const decodedCursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;
      const rows = await reviewsRepo.listPublishedByProductCursor({
        productId,
        limit: query.limit + 1,
        ...(decodedCursor !== undefined ? { cursor: decodedCursor } : {}),
        ...(query.rating !== undefined ? { rating: query.rating } : {}),
      });

      return buildCursorPage(rows, query.limit, serializeReview);
    },

    async listAdminReviews(
      actor: AuthUser,
      query: ListAdminReviewsQuery,
    ): Promise<CursorPage<PublicProductReview>> {
      assertAdminUser(actor);

      const filters = {
        ...(query.productId !== undefined ? { productId: query.productId } : {}),
        ...(query.userId !== undefined ? { userId: query.userId } : {}),
        ...(query.isPublished !== undefined ? { isPublished: query.isPublished } : {}),
        ...(query.rating !== undefined ? { rating: query.rating } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.createdFrom !== undefined ? { createdFrom: query.createdFrom } : {}),
        ...(query.createdTo !== undefined ? { createdTo: query.createdTo } : {}),
      };

      return paginateAdminList({
        query,
        listOffset: ({ limit, offset }) =>
          reviewsRepo.listAdminOffset({ limit, offset, ...filters }),
        listCursor: ({ limit, cursor }) =>
          reviewsRepo.listAdminCursor({
            limit,
            ...(cursor !== undefined ? { cursor } : {}),
            ...filters,
          }),
        serialize: serializeReview,
      });
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
      if (product === null || !isRecordActive(product)) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      const created = await reviewsRepo.createAndSyncProductRating({
        id: generateId(),
        productId,
        userId: actor.id,
        orderId: body.orderId ?? null,
        rating: body.rating,
        comment:
          body.comment !== undefined && body.comment !== null
            ? sanitizeMarkdown(body.comment)
            : null,
      });

      await revalidator.notify(['products', `product:${product.slug}`, 'sitemap']);
      return serializeReview(created);
    },

    async updateOwnProductReview(
      actor: AuthUser,
      productId: string,
      body: UpdateOwnReviewBody,
    ): Promise<PublicProductReview> {
      const product = await productsRepo.findById(productId);
      if (product === null || !isRecordActive(product)) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      const updated = await reviewsRepo.updateOwnReviewAndSyncRating({
        productId,
        userId: actor.id,
        ...(body.rating !== undefined ? { rating: body.rating } : {}),
        ...(body.comment !== undefined
          ? {
              comment: body.comment !== null ? sanitizeMarkdown(body.comment) : null,
            }
          : {}),
      });
      if (updated === null) {
        throw new NotFoundError('Review not found', 'REVIEW_NOT_FOUND');
      }

      await revalidator.notify(['products', `product:${product.slug}`, 'sitemap']);
      return serializeReview(updated);
    },

    async deleteOwnProductReview(actor: AuthUser, productId: string): Promise<void> {
      const product = await productsRepo.findById(productId);
      if (product === null || !isRecordActive(product)) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      const deleted = await reviewsRepo.softDeleteOwnReviewAndSyncRating({
        productId,
        userId: actor.id,
      });
      if (!deleted) {
        throw new NotFoundError('Review not found', 'REVIEW_NOT_FOUND');
      }

      await revalidator.notify(['products', `product:${product.slug}`, 'sitemap']);
    },

    async moderateReview(
      actor: AuthUser,
      reviewId: string,
      body: ModerateReviewBody,
    ): Promise<PublicProductReview> {
      assertAdminUser(actor);

      const nextActive = resolveActiveStateInput(body);
      const updated = await reviewsRepo.updatePublishStateAndSyncRating(reviewId, {
        ...(body.isPublished !== undefined ? { isPublished: body.isPublished } : {}),
        ...(nextActive !== undefined ? { isActive: nextActive } : {}),
      });
      if (updated === null) {
        throw new NotFoundError('Review not found', 'REVIEW_NOT_FOUND');
      }

      const product = await productsRepo.findById(updated.productId);
      if (product !== null) {
        await revalidator.notify(['products', `product:${product.slug}`, 'sitemap']);
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
        await revalidator.notify(['products', `product:${product.slug}`, 'sitemap']);
      }
    },
  };
}
