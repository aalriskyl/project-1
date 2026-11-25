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

/**
 * Users table (`public.users`).
 * - Supports both Argon2id email/password accounts and Google OAuth accounts (`google_sub`).
 * - `phone` is stored as a profile/shipping/WhatsApp contact (E.164), not an unverified login key.
 * - RLS is enabled per Supabase security rules.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: text('password_hash'),
    googleSub: varchar('google_sub', { length: 128 }),
    phone: varchar('phone', { length: 24 }),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    role: varchar('role', { length: 32 }).notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('users_created_at_id_idx').on(table.createdAt, table.id),
    index('users_search_trgm_gin_idx').using(
      'gin',
      sql`(${table.displayName} || ' ' || ${table.email} || ' ' || coalesce(${table.phone}, '')) extensions.gin_trgm_ops`,
    ),
    uniqueIndex('users_google_sub_uidx')
      .on(table.googleSub)
      .where(sql`${table.googleSub} is not null`),
    check(
      'users_credential_present_chk',
      sql`${table.passwordHash} is not null or ${table.googleSub} is not null`,
    ),
  ],
).enableRLS();

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
