import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { products } from '@/db/schema/products.ts';

/**
 * Public pre-order / RFQ requests submitted from product pages.
 * PII is limited to the contact fields and is never written to logs.
 */
export const inquiries = pgTable(
  'inquiries',
  {
    id: uuid('id').primaryKey(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 120 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    phone: varchar('phone', { length: 40 }),
    message: text('message').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('new'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    requestFingerprint: varchar('request_fingerprint', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('inquiries_idempotency_key_uidx').on(table.idempotencyKey),
    check('inquiries_status_chk', sql`${table.status} in ('new', 'contacted', 'closed')`),
    index('inquiries_status_created_id_idx').on(
      table.status,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('inquiries_created_id_idx').on(table.createdAt.desc(), table.id.desc()),
    index('inquiries_product_id_idx').on(table.productId),
  ],
).enableRLS();

export type InquiryRow = typeof inquiries.$inferSelect;
