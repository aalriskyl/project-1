import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { productReviews } from '@/db/schema/product-reviews.ts';
import { products } from '@/db/schema/products.ts';
import type { SeededReviewsResult } from '@/db/seeders/types.ts';
import { generateId } from '@/lib/id.ts';

interface SeedReviewSpec {
  readonly productKey: string;
  readonly rating: number;
  readonly comment: string;
}

const REVIEW_SPECS: readonly SeedReviewSpec[] = [
  {
    productKey: 'tpg30',
    rating: 5,
    comment:
      'Suara canopy sangat halus, uji beban 30 kVA stabil dan pengiriman teknisi tepat waktu.',
  },
  {
    productKey: 'tcc500',
    rating: 4,
    comment: 'Potongan aspal rapi dan rangka kokoh. Tangki air cukup besar untuk pekerjaan proyek.',
  },
];

async function ensureReviewAndSyncRating(
  database: Database,
  input: {
    readonly productId: string;
    readonly userId: string;
    readonly rating: number;
    readonly comment: string;
  },
): Promise<void> {
  await database.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: productReviews.id })
      .from(productReviews)
      .where(
        and(
          eq(productReviews.productId, input.productId),
          eq(productReviews.userId, input.userId),
          isNull(productReviews.orderId),
        ),
      )
      .limit(1);

    if (existing === undefined) {
      await tx.insert(productReviews).values({
        id: generateId(),
        productId: input.productId,
        userId: input.userId,
        orderId: null,
        rating: input.rating,
        comment: input.comment,
        isPublished: true,
      });
    }

    const [stats] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        avg: sql<string>`coalesce(round(avg(${productReviews.rating})::numeric, 2), 0.00)::text`,
      })
      .from(productReviews)
      .where(
        and(eq(productReviews.productId, input.productId), eq(productReviews.isPublished, true)),
      );

    await tx
      .update(products)
      .set({
        reviewCount: stats?.count ?? 0,
        ratingAvg: stats?.avg ?? '0.00',
        updatedAt: new Date(),
      })
      .where(eq(products.id, input.productId));
  });
}

/**
 * Seeds published customer reviews and transactionally updates `products.rating_avg` & `review_count`.
 */
export async function seedReviews(
  database: Database,
  reviewerId: string,
  productIdsByKey: ReadonlyMap<string, string>,
): Promise<SeededReviewsResult> {
  for (const review of REVIEW_SPECS) {
    const prodId = productIdsByKey.get(review.productKey);
    if (prodId !== undefined) {
      await ensureReviewAndSyncRating(database, {
        productId: prodId,
        userId: reviewerId,
        rating: review.rating,
        comment: review.comment,
      });
    }
  }
  return { count: REVIEW_SPECS.length };
}
