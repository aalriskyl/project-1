import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { products } from '@/db/schema/products.ts';
import { users } from '@/db/schema/users.ts';

/**
 * Customer product reviews (`public.product_reviews`).
 * Mutations recalculate `products.rating_avg` and `products.review_count` transactionally.
 */
export const productReviews = pgTable(
  'product_reviews',
  {
    id: uuid('id').primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id'),
    rating: smallint('rating').notNull(),
    comment: text('comment'),
    isPublished: boolean('is_published').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check('product_reviews_rating_range_chk', sql`${table.rating} >= 1 and ${table.rating} <= 5`),
    uniqueIndex('product_reviews_user_product_no_order_uidx')
      .on(table.userId, table.productId)
      .where(sql`${table.orderId} is null`),
    uniqueIndex('product_reviews_order_product_uidx')
      .on(table.orderId, table.productId)
      .where(sql`${table.orderId} is not null`),
    index('product_reviews_product_pub_created_idx').on(
      table.productId,
      table.isPublished,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('product_reviews_user_id_idx').on(table.userId),
  ],
).enableRLS();

export type ProductReviewRow = typeof productReviews.$inferSelect;
export type NewProductReviewRow = typeof productReviews.$inferInsert;
