import { generateId } from '@/lib/id.ts';
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
  createUploadUrl(actor: AuthUser, input: RequestUploadUrlBody): Promise<SignedUploadResult>;
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
    ): Promise<SignedUploadResult> {
      assertAdminUser(actor);
      const signed = await provider.createSignedImageUpload(input);

      await mediaRepo.recordUpload({
        id: generateId(),
        bucket: signed.bucket,
        objectPath: signed.objectPath,
        publicUrl: signed.publicUrl,
        contentType: input.contentType,
        uploadedBy: actor.id,
      });

      return signed;
    },

    async cleanupOrphans(
      actor: AuthUser,
      input: CleanupOrphansBody,
    ): Promise<CleanupOrphansResult> {
      assertAdminUser(actor);

      const cutoff = new Date(Date.now() - input.olderThanHours * 3_600 * 1_000);
      const candidates = await mediaRepo.listSweepCandidates({
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

      const deletedIds: string[] = [];
      const deletedPaths: string[] = [];

      for (const [bucket, items] of byBucket.entries()) {
        const referenced = await mediaRepo.collectAllReferencedObjectPaths(bucket);
        const orphans = items.filter((item) => !referenced.has(item.objectPath));
        if (orphans.length === 0) continue;

        const orphanPaths = orphans.map((o) => o.objectPath);
        await provider.deleteObjects(bucket, orphanPaths);

        for (const orphan of orphans) {
          deletedIds.push(orphan.id);
          deletedPaths.push(orphan.objectPath);
        }
      }

      if (deletedIds.length > 0) {
        await mediaRepo.markDeletedByIds(deletedIds, new Date());
      }

      return {
        scannedCount: candidates.length,
        deletedCount: deletedPaths.length,
        deletedPaths,
      };
    },
  };
}
