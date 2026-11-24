import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from '@/db/schema/users.ts';

/**
 * SEO Markdown articles (`public.articles`).
 * Supports non-developer publishing, Next.js ISR tag invalidation, `app/sitemap.ts` generation,
 * and `related_product_ids` for funneling organic readers directly to product pages.
 */
export const articles = pgTable(
  'articles',
  {
    id: uuid('id').primaryKey(),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 280 }).notNull(),
    excerpt: text('excerpt'),
    contentMd: text('content_md').notNull(),
    coverImageUrl: text('cover_image_url'),
    metaTitle: varchar('meta_title', { length: 160 }),
    metaDescription: varchar('meta_description', { length: 320 }),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    relatedProductIds: uuid('related_product_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    isPublished: boolean('is_published').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('articles_slug_active_uidx')
      .on(table.slug)
      .where(sql`${table.deletedAt} is null`),
    index('articles_author_id_idx').on(table.authorId),
    index('articles_published_feed_idx')
      .on(table.publishedAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null and ${table.isPublished} = true`),
    index('articles_admin_created_id_idx')
      .on(table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null`),
    index('articles_tags_gin_idx').using('gin', table.tags),
  ],
).enableRLS();

export type ArticleRow = typeof articles.$inferSelect;
export type NewArticleRow = typeof articles.$inferInsert;
