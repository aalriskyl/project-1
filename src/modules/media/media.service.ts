import { generateId } from '@/lib/id.ts';
import { env } from '@/config/env.ts';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@/lib/errors.ts';
import { type SignedUploadResult, type StorageProvider, storageProvider } from '@/lib/storage.ts';
import { assertAdminUser } from '@/middlewares/authorize.ts';
import type { MediaRepository } from '@/modules/media/media.repository.ts';
import type {
  CleanupOrphansBody,
  CleanupOrphansResult,
  RequestUploadUrlBody,
} from '@/modules/media/media.schema.ts';
import type { AuthUser } from '@/types/app.ts';

export interface MediaService {
  createUploadUrl(
    actor: AuthUser,
    input: RequestUploadUrlBody,
  ): Promise<SignedUploadResult & { uploadId: string }>;
  completeUpload(
    actor: AuthUser,
    id: string,
  ): Promise<{ uploadId: string; publicUrl: string; status: 'verified' }>;
  cleanupOrphans(actor: AuthUser, input: CleanupOrphansBody): Promise<CleanupOrphansResult>;
}

export function createMediaService(
  mediaRepo: MediaRepository,
  provider: StorageProvider = storageProvider,
): MediaService {
  return {
    async createUploadUrl(
      actor: AuthUser,
      input: RequestUploadUrlBody,
    ): Promise<SignedUploadResult & { uploadId: string }> {
      assertAdminUser(actor);
      const signed = await provider.createSignedImageUpload(input);

      const uploadId = generateId();
      await mediaRepo.recordUpload({
        id: uploadId,
        bucket: signed.bucket,
        objectPath: signed.objectPath,
        publicUrl: signed.publicUrl,
        contentType: input.contentType,
        expectedBytes: input.contentLengthBytes,
        uploadedBy: actor.id,
      });

      return { ...signed, uploadId };
    },

    async completeUpload(actor, id) {
      assertAdminUser(actor);
      const row = await mediaRepo.findById(id);
      if (row === null || row.deletedAt !== null)
        throw new NotFoundError('Media upload not found', 'MEDIA_NOT_FOUND');
      if (row.deletingAt !== null)
        throw new ConflictError('Media upload is being deleted', 'MEDIA_DELETING');
      if (row.verifiedAt !== null)
        return { uploadId: row.id, publicUrl: row.publicUrl, status: 'verified' };
      await provider.verifyImageUpload(
        row.bucket,
        row.objectPath,
        row.contentType,
        row.expectedBytes,
      );
      const verified = await mediaRepo.markVerified(id, new Date());
      if (verified === null)
        throw new ConflictError('Media upload is being deleted', 'MEDIA_DELETING');
      return { uploadId: verified.id, publicUrl: verified.publicUrl, status: 'verified' };
    },

    async cleanupOrphans(
      actor: AuthUser,
      input: CleanupOrphansBody,
    ): Promise<CleanupOrphansResult> {
      assertAdminUser(actor);
      if (env.NODE_ENV === 'production' && !env.MEDIA_CLEANUP_ENABLED)
        throw new ServiceUnavailableError(
          'Media cleanup is disabled until reference backfill and rollout are complete',
          'MEDIA_CLEANUP_DISABLED',
        );
      if (input.olderThanHours < 3)
        throw new ValidationError('Cleanup grace window must exceed the signed upload lifetime', [
          { field: 'olderThanHours', message: 'Must be at least 3 hours' },
        ]);

      const cutoff = new Date(Date.now() - input.olderThanHours * 3_600 * 1_000);
      const candidates = await mediaRepo.claimOrphans({
        olderThan: cutoff,
        limit: input.limit,
      });

      if (candidates.length === 0) {
        return { scannedCount: 0, deletedCount: 0, deletedPaths: [] };
      }

      const byBucket = new Map<string, (typeof candidates)[number][]>();
      for (const item of candidates) {
        const group = byBucket.get(item.bucket) ?? [];
        group.push(item);
        byBucket.set(item.bucket, group);
      }

      const deletedPaths: string[] = [];

      for (const [bucket, items] of byBucket.entries()) {
        const orphanPaths = items.map((o) => o.objectPath);
        try {
          await provider.deleteObjects(bucket, orphanPaths);
        } catch (err) {
          const remainingIds = candidates
            .filter((c) => !deletedPaths.includes(c.objectPath))
            .map((c) => c.id);
          await mediaRepo.releaseOrphanClaims(remainingIds);
          throw err;
        }

        for (const orphan of items) {
          deletedPaths.push(orphan.objectPath);
        }
        await mediaRepo.markDeletedByIds(
          items.map((item) => item.id),
          new Date(),
        );
      }

      return {
        scannedCount: candidates.length,
        deletedCount: deletedPaths.length,
        deletedPaths,
      };
    },
  };
}
