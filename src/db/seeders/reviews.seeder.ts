import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { productReviews } from '@/db/schema/product-reviews.ts';
import { products } from '@/db/schema/products.ts';
import type { SeededReviewsResult } from '@/db/seeders/types.ts';
import { generateId } from '@/lib/auth/id.ts';

interface SeedReviewSpec {
  readonly productKey: string;
  readonly authorSlot: 'primary' | 'secondary';
  readonly rating: number;
  readonly comment: string;
  readonly isPublished: boolean;
}

const REVIEW_SPECS: readonly SeedReviewSpec[] = [
  {
    productKey: 'tpg30',
    authorSlot: 'primary',
    rating: 5,
    comment:
      'Suara canopy sangat halus, uji beban 30 kVA stabil dan pengiriman teknisi tepat waktu.',
    isPublished: true,
  },
  {
    productKey: 'tpg30',
    authorSlot: 'secondary',
    rating: 4,
    comment: 'Konsumsi solar irit untuk operasional klinik 12 jam. Panel DeepSea mudah dipantau.',
    isPublished: true,
  },
  {
    productKey: 'tpg50',
    authorSlot: 'primary',
    rating: 5,
    comment: 'Genset 50 kVA handal untuk pabrik kami, start cepat saat listrik PLN padam.',
    isPublished: true,
  },
  {
    productKey: 'tcc500',
    authorSlot: 'primary',
    rating: 4,
    comment: 'Potongan aspal rapi dan rangka kokoh. Tangki air cukup besar untuk pekerjaan proyek.',
    isPublished: true,
  },
  {
    productKey: 'tcg100',
    authorSlot: 'secondary',
    rating: 2,
    comment: 'Menunggu jadwal commissioning teknisi (ulasan belum dipublikasikan untuk moderasi).',
    isPublished: false,
  },
];

async function ensureReviewAndSyncRating(
  database: Database,
  input: {
    readonly productId: string;
    readonly userId: string;
    readonly rating: number;
    readonly comment: string;
    readonly isPublished: boolean;
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
          isNull(productReviews.deletedAt),
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
        isPublished: input.isPublished,
        isActive: true,
      });
    }

    const [stats] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        avg: sql<string>`coalesce(round(avg(${productReviews.rating})::numeric, 2), 0.00)::text`,
      })
      .from(productReviews)
      .where(
        and(
          eq(productReviews.productId, input.productId),
          eq(productReviews.isPublished, true),
          eq(productReviews.isActive, true),
          isNull(productReviews.deletedAt),
        ),
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
 * Seeds published and pending-moderation customer reviews and transactionally updates
 * `products.rating_avg` & `review_count` using only active, published reviews.
 */
export async function seedReviews(
  database: Database,
  reviewers: { readonly primary: string; readonly secondary: string },
  productIdsByKey: ReadonlyMap<string, string>,
): Promise<SeededReviewsResult> {
  for (const review of REVIEW_SPECS) {
    const prodId = productIdsByKey.get(review.productKey);
    if (prodId !== undefined) {
      const userId = review.authorSlot === 'primary' ? reviewers.primary : reviewers.secondary;
      await ensureReviewAndSyncRating(database, {
        productId: prodId,
        userId,
        rating: review.rating,
        comment: review.comment,
        isPublished: review.isPublished,
      });
    }
  }
  return { count: REVIEW_SPECS.length };
}
