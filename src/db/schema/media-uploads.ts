import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from '@/db/schema/users.ts';

/**
 * Tracks presigned uploads issued by `/v1/admin/media/upload-url` (`public.media_uploads`)
 * so unreferenced orphan files older than the retention grace window can be swept safely.
 */
export const mediaUploads = pgTable(
  'media_uploads',
  {
    id: uuid('id').primaryKey(),
    bucket: varchar('bucket', { length: 63 }).notNull(),
    objectPath: text('object_path').notNull(),
    publicUrl: text('public_url').notNull(),
    contentType: varchar('content_type', { length: 64 }).notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('media_uploads_bucket_path_uidx').on(table.bucket, table.objectPath),
    index('media_uploads_uploaded_by_idx').on(table.uploadedBy),
    index('media_uploads_sweep_created_id_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.deletedAt} is null`),
  ],
).enableRLS();

export type MediaUploadRow = typeof mediaUploads.$inferSelect;
export type NewMediaUploadRow = typeof mediaUploads.$inferInsert;
