import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Permanent slug mappings used by the frontend to issue 301 redirects after a
 * category/product/article is renamed. Slugs are unique per entity type, so
 * `(entity_type, old_slug)` is the natural key.
 */
export const slugRedirects = pgTable(
  'slug_redirects',
  {
    entityType: varchar('entity_type', { length: 16 }).notNull(),
    oldSlug: varchar('old_slug', { length: 280 }).notNull(),
    newSlug: varchar('new_slug', { length: 280 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'slug_redirects_pk', columns: [table.entityType, table.oldSlug] }),
    index('slug_redirects_new_slug_idx').on(table.entityType, table.newSlug),
    check('slug_redirects_no_self_chk', sql`${table.oldSlug} <> ${table.newSlug}`),
  ],
).enableRLS();

export type SlugRedirectRow = typeof slugRedirects.$inferSelect;
