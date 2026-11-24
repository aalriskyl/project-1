import { and, asc, inArray, isNull, lte } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { articles } from '@/db/schema/articles.ts';
import { categories } from '@/db/schema/categories.ts';
import { type MediaUploadRow, mediaUploads } from '@/db/schema/media-uploads.ts';
import { products } from '@/db/schema/products.ts';
import { extractReferencedObjectPaths } from '@/lib/asset-url.ts';

export interface CreateMediaUploadRecord {
  readonly id: string;
  readonly bucket: string;
  readonly objectPath: string;
  readonly publicUrl: string;
  readonly contentType: string;
  readonly uploadedBy: string;
}

export interface MediaRepository {
  recordUpload(input: CreateMediaUploadRecord): Promise<MediaUploadRow>;
  listSweepCandidates(params: {
    readonly olderThan: Date;
    readonly limit: number;
  }): Promise<readonly MediaUploadRow[]>;
  collectAllReferencedObjectPaths(bucket: string): Promise<ReadonlySet<string>>;
  markDeletedByIds(ids: readonly string[], deletedAt: Date): Promise<void>;
}

export function createMediaRepository(db: Database): MediaRepository {
  return {
    async recordUpload(input: CreateMediaUploadRecord): Promise<MediaUploadRow> {
      const [created] = await db
        .insert(mediaUploads)
        .values({
          id: input.id,
          bucket: input.bucket,
          objectPath: input.objectPath,
          publicUrl: input.publicUrl,
          contentType: input.contentType,
          uploadedBy: input.uploadedBy,
        })
        .returning();

      if (created === undefined) {
        throw new Error('Failed to record media upload');
      }
      return created;
    },

    async listSweepCandidates({ olderThan, limit }): Promise<readonly MediaUploadRow[]> {
      return db
        .select()
        .from(mediaUploads)
        .where(and(isNull(mediaUploads.deletedAt), lte(mediaUploads.createdAt, olderThan)))
        .orderBy(asc(mediaUploads.createdAt), asc(mediaUploads.id))
        .limit(limit);
    },

    async collectAllReferencedObjectPaths(bucket: string): Promise<ReadonlySet<string>> {
      const [catRows, prodRows, artRows] = await Promise.all([
        db
          .select({
            imageUrl: categories.imageUrl,
            bannerImageUrl: categories.bannerImageUrl,
            description: categories.description,
          })
          .from(categories)
          .where(isNull(categories.deletedAt)),
        db
          .select({
            primaryImageUrl: products.primaryImageUrl,
            media: products.media,
            descriptionMd: products.descriptionMd,
          })
          .from(products)
          .where(isNull(products.deletedAt)),
        db
          .select({
            coverImageUrl: articles.coverImageUrl,
            contentMd: articles.contentMd,
          })
          .from(articles)
          .where(isNull(articles.deletedAt)),
      ]);

      const rawSources: (string | null | undefined)[] = [];
      for (const c of catRows) {
        rawSources.push(c.imageUrl, c.bannerImageUrl, c.description);
      }
      for (const p of prodRows) {
        rawSources.push(p.primaryImageUrl, p.descriptionMd);
        for (const m of p.media) {
          rawSources.push(m.url);
        }
      }
      for (const a of artRows) {
        rawSources.push(a.coverImageUrl, a.contentMd);
      }

      return extractReferencedObjectPaths(rawSources, bucket);
    },

    async markDeletedByIds(ids: readonly string[], deletedAt: Date): Promise<void> {
      if (ids.length === 0) return;
      await db
        .update(mediaUploads)
        .set({ deletedAt })
        .where(inArray(mediaUploads.id, [...ids]));
    },
  };
}
