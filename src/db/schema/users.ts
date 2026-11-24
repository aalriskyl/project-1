import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Users table (`public.users`).
 * Row Level Security (RLS) is explicitly enabled per Supabase security rules so the table
 * cannot be read or mutated through Supabase's auto-exposed PostgREST Data API using the `anon` key.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    role: varchar('role', { length: 32 }).notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('users_created_at_id_idx').on(table.createdAt, table.id)],
).enableRLS();

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
