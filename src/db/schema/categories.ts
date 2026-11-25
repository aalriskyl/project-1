import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export type SpecFieldType = 'number' | 'text' | 'boolean';

export interface SpecFieldDefRow {
  readonly key: string;
  readonly label: string;
  readonly unit?: string;
  readonly type: SpecFieldType;
  readonly sortOrder: number;
}

/**
 * Self-referencing product taxonomy (`public.categories`).
 * - Root categories (`parent_id IS NULL`) represent top-level lines (e.g. "Genset Silent").
 * - Child categories (`parent_id IS NOT NULL`) represent subcategories (e.g. "Engine Perkins")
 *   and inherit `spec_schema` definitions from their parent.
 * - RLS is enabled per Supabase security rules.
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey(),
    parentId: uuid('parent_id'),
    name: varchar('name', { length: 120 }).notNull(),
    slug: varchar('slug', { length: 140 }).notNull(),
    description: text('description'),
    metaTitle: varchar('meta_title', { length: 160 }),
    metaDescription: varchar('meta_description', { length: 320 }),
    focusKeyword: varchar('focus_keyword', { length: 120 }),
    canonicalUrl: text('canonical_url'),
    noIndex: boolean('no_index').notNull().default(false),
    ogImageUrl: text('og_image_url'),
    imageUrl: text('image_url'),
    bannerImageUrl: text('banner_image_url'),
    specSchema: jsonb('spec_schema').$type<SpecFieldDefRow[]>().notNull().default([]),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: 'categories_parent_id_categories_id_fk',
    }).onDelete('restrict'),
    uniqueIndex('categories_slug_active_uidx')
      .on(table.slug)
      .where(sql`${table.deletedAt} is null`),
    index('categories_parent_sort_id_idx').on(table.parentId, table.sortOrder, table.id),
    index('categories_active_sort_id_idx')
      .on(table.sortOrder, table.id)
      .where(sql`${table.deletedAt} is null and ${table.isActive} = true`),
    index('categories_search_trgm_gin_idx').using(
      'gin',
      sql`(${table.name} || ' ' || ${table.slug} || ' ' || coalesce(${table.description}, '')) extensions.gin_trgm_ops`,
    ),
  ],
).enableRLS();

export type CategoryRow = typeof categories.$inferSelect;
export type NewCategoryRow = typeof categories.$inferInsert;
