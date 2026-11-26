import { type SQL, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { categories } from '@/db/schema/categories.ts';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export type ProductMediaType = 'image' | 'video';

export interface ProductMediaItemRow {
  readonly id: string;
  readonly type: ProductMediaType;
  readonly url: string;
  readonly altText?: string;
}

export type ProductSpecValue = string | number | boolean;
export type ProductSpecsMap = Record<string, ProductSpecValue>;

export interface ProductCustomSpecRow {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
}

/**
 * Industrial equipment & spare-parts catalog (`public.products`).
 * - Stores bounded `media` JSONB + `specs` JSONB (GIN `jsonb_path_ops`) and denormalized
 *   `primary_image_url`, `rating_avg`, and `review_count` for zero-join cards & 1-row detail views.
 * - Uses `'simple'` dictionary `tsvector` + `pg_trgm` GIN index for Indonesian terms and SKU codes.
 * - RLS is enabled per Supabase security rules.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    brandSlug: varchar('brand_slug', { length: 64 }),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 280 }).notNull(),
    sku: varchar('sku', { length: 80 }),
    productType: varchar('product_type', { length: 24 }).notNull().default('equipment'),
    descriptionMd: text('description_md'),
    metaTitle: varchar('meta_title', { length: 160 }),
    metaDescription: varchar('meta_description', { length: 320 }),
    focusKeyword: varchar('focus_keyword', { length: 120 }),
    canonicalUrl: text('canonical_url'),
    noIndex: boolean('no_index').notNull().default(false),
    ogImageUrl: text('og_image_url'),
    priceIdr: bigint('price_idr', { mode: 'number' }).notNull(),
    requiresQuote: boolean('requires_quote').notNull().default(false),
    stock: integer('stock').notNull().default(0),
    isFeatured: boolean('is_featured').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    primaryImageUrl: text('primary_image_url'),
    media: jsonb('media').$type<ProductMediaItemRow[]>().notNull().default([]),
    specs: jsonb('specs').$type<ProductSpecsMap>().notNull().default({}),
    customSpecs: jsonb('custom_specs').$type<ProductCustomSpecRow[]>().notNull().default([]),
    lengthCm: numeric('length_cm', { precision: 10, scale: 2 }),
    widthCm: numeric('width_cm', { precision: 10, scale: 2 }),
    heightCm: numeric('height_cm', { precision: 10, scale: 2 }),
    weightKg: numeric('weight_kg', { precision: 10, scale: 2 }),
    ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }).notNull().default('0.00'),
    reviewCount: integer('review_count').notNull().default(0),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('simple', coalesce(${products.name}, '') || ' ' || coalesce(${products.sku}, '') || ' ' || coalesce(${products.brandSlug}, '') || ' ' || coalesce(${products.descriptionMd}, ''))`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check(
      'products_non_negative_values_chk',
      sql`${table.priceIdr} >= 0 and ${table.stock} >= 0 and ${table.reviewCount} >= 0`,
    ),
    uniqueIndex('products_slug_active_uidx')
      .on(table.slug)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex('products_sku_active_uidx')
      .on(table.sku)
      .where(sql`${table.deletedAt} is null and ${table.sku} is not null`),
    index('products_category_created_id_idx').on(
      table.categoryId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('products_brand_created_id_idx')
      .on(table.brandSlug, table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null and ${table.brandSlug} is not null`),
    index('products_featured_created_id_idx')
      .on(table.isFeatured, table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null and ${table.isActive} = true`),
    index('products_active_created_id_idx')
      .on(table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null and ${table.isActive} = true`),
    index('products_specs_gin_idx').using('gin', table.specs.op('jsonb_path_ops')),
    index('products_search_vector_gin_idx').using('gin', table.searchVector),
    index('products_name_sku_trgm_gin_idx').using(
      'gin',
      sql`(${table.name} || ' ' || coalesce(${table.sku}, '')) extensions.gin_trgm_ops`,
    ),
  ],
).enableRLS();

/**
 * Many-to-many graph linking parent equipment to compatible spare-part products (`public.product_spareparts`).
 */
export const productSpareparts = pgTable(
  'product_spareparts',
  {
    parentProductId: uuid('parent_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sparepartProductId: uuid('sparepart_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    note: varchar('note', { length: 160 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'product_spareparts_pk',
      columns: [table.parentProductId, table.sparepartProductId],
    }),
    index('product_spareparts_sparepart_id_idx').on(table.sparepartProductId),
    check(
      'product_spareparts_no_self_link_chk',
      sql`${table.parentProductId} <> ${table.sparepartProductId}`,
    ),
  ],
).enableRLS();

export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;
export type ProductSparepartRow = typeof productSpareparts.$inferSelect;
