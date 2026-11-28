import { and, asc, eq, inArray, isNull, lte, notExists, or } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { mediaReferences, type MediaUploadRow, mediaUploads } from '@/db/schema/media-uploads.ts';
import { lockMediaEntity, lockOrphanSweep } from '@/modules/media/media-attachments.repository.ts';

const ORPHAN_CLAIM_LEASE_MS = 15 * 60 * 1_000;

export interface CreateMediaUploadRecord {
  readonly id: string;
  readonly bucket: string;
  readonly objectPath: string;
  readonly publicUrl: string;
  readonly contentType: string;
  readonly expectedBytes: number;
  readonly uploadedBy: string;
}
export interface MediaRepository {
  recordUpload(input: CreateMediaUploadRecord): Promise<MediaUploadRow>;
  findById(id: string): Promise<MediaUploadRow | null>;
  markVerified(id: string, verifiedAt: Date): Promise<MediaUploadRow | null>;
  claimOrphans(params: {
    readonly olderThan: Date;
    readonly limit: number;
  }): Promise<readonly MediaUploadRow[]>;
  releaseOrphanClaims(
    claims: readonly { readonly id: string; readonly deletingAt: Date }[],
  ): Promise<void>;
  markDeletedByIds(ids: readonly string[], deletedAt: Date): Promise<void>;
}
export function createMediaRepository(db: Database): MediaRepository {
  return {
    async recordUpload(input) {
      const [created] = await db.insert(mediaUploads).values(input).returning();
      if (created === undefined) throw new Error('Failed to record media upload');
      return created;
    },
    async findById(id) {
      const [row] = await db.select().from(mediaUploads).where(eq(mediaUploads.id, id));
      return row ?? null;
    },
    async markVerified(id, verifiedAt) {
      return db.transaction(async (tx) => {
        await lockMediaEntity(tx, 'uploads', id);
        const [row] = await tx
          .update(mediaUploads)
          .set({ verifiedAt })
          .where(
            and(
              eq(mediaUploads.id, id),
              isNull(mediaUploads.deletedAt),
              isNull(mediaUploads.deletingAt),
            ),
          )
          .returning();
        return row ?? null;
      });
    },
    async claimOrphans({ olderThan, limit }) {
      return db.transaction(async (tx) => {
        await lockOrphanSweep(tx);
        const now = new Date();
        const staleClaimCutoff = new Date(now.getTime() - ORPHAN_CLAIM_LEASE_MS);
        const rows = await tx
          .select()
          .from(mediaUploads)
          .where(
            and(
              isNull(mediaUploads.deletedAt),
              or(isNull(mediaUploads.deletingAt), lte(mediaUploads.deletingAt, staleClaimCutoff)),
              lte(mediaUploads.createdAt, olderThan),
              notExists(
                tx
                  .select({ id: mediaReferences.uploadId })
                  .from(mediaReferences)
                  .where(eq(mediaReferences.uploadId, mediaUploads.id)),
              ),
            ),
          )
          .orderBy(asc(mediaUploads.createdAt), asc(mediaUploads.id))
          .limit(limit);
        if (rows.length === 0) return [];

        // Same per-upload lock the attachment path uses. Re-check references and
        // lease state under the lock so an in-flight attachment cannot be deleted.
        for (const row of rows) {
          await lockMediaEntity(tx, 'uploads', row.id);
        }
        const stillOrphaned = await tx
          .select({ id: mediaUploads.id })
          .from(mediaUploads)
          .where(
            and(
              inArray(
                mediaUploads.id,
                rows.map((r) => r.id),
              ),
              isNull(mediaUploads.deletedAt),
              or(isNull(mediaUploads.deletingAt), lte(mediaUploads.deletingAt, staleClaimCutoff)),
              notExists(
                tx
                  .select({ id: mediaReferences.uploadId })
                  .from(mediaReferences)
                  .where(eq(mediaReferences.uploadId, mediaUploads.id)),
              ),
            ),
          );
        const claimableIds = new Set(stillOrphaned.map((row) => row.id));
        const claimable = rows.filter((row) => claimableIds.has(row.id));
        if (claimable.length > 0)
          await tx
            .update(mediaUploads)
            .set({ deletingAt: now })
            .where(
              inArray(
                mediaUploads.id,
                claimable.map((r) => r.id),
              ),
            );
        return claimable.map((row) => ({ ...row, deletingAt: now }));
      });
    },
    async releaseOrphanClaims(claims) {
      if (claims.length === 0) return;
      // Compare-and-swap on the exact lease timestamp so a sweep cannot clear a
      // lease that a later sweep has already re-claimed.
      const matchClaims = claims.map((claim) =>
        and(eq(mediaUploads.id, claim.id), eq(mediaUploads.deletingAt, claim.deletingAt)),
      );
      await db
        .update(mediaUploads)
        .set({ deletingAt: null })
        .where(and(isNull(mediaUploads.deletedAt), or(...matchClaims)));
    },
    async markDeletedByIds(ids, deletedAt) {
      if (ids.length > 0)
        await db
          .update(mediaUploads)
          .set({ deletedAt })
          .where(inArray(mediaUploads.id, [...ids]));
    },
  };
}
