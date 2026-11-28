import { and, eq, inArray, sql } from 'drizzle-orm';
import { env } from '@/config/env.ts';
import type { Database } from '@/db/client.ts';
import { mediaReferences, mediaUploads } from '@/db/schema/media-uploads.ts';
import { extractReferencedObjectPaths } from '@/lib/shared/asset-url.ts';
import { ConflictError } from '@/lib/shared/errors.ts';

export type MediaTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type MediaOwner = 'products' | 'categories' | 'articles' | 'uploads';

const MEDIA_LOCK_SEED = 724193;
const ORPHAN_SWEEP_LOCK_KEY = 'media:orphan-sweep';

/**
 * Advisory locks are keyed per entity so concurrent edits to different rows never
 * block each other. A single cluster-wide lock here would queue every catalog
 * write behind one transaction and exhaust the transaction-pool connections.
 */
export function mediaEntityLockKey(owner: MediaOwner, ownerId: string): string {
  return `media:${owner}:${ownerId}`;
}

async function acquireAdvisoryLock(tx: MediaTransaction, lockKey: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, ${MEDIA_LOCK_SEED}))`,
  );
}

export async function lockMediaEntity(
  tx: MediaTransaction,
  owner: MediaOwner,
  ownerId: string,
): Promise<void> {
  await acquireAdvisoryLock(tx, mediaEntityLockKey(owner, ownerId));
}

/** The orphan claim sweep still needs mutual exclusion, but only for its own short transaction. */
export async function lockOrphanSweep(tx: MediaTransaction): Promise<void> {
  await acquireAdvisoryLock(tx, ORPHAN_SWEEP_LOCK_KEY);
}

export function collectMediaStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectMediaStrings);
  if (value !== null && typeof value === 'object' && !(value instanceof Date))
    return Object.values(value).flatMap(collectMediaStrings);
  return [];
}

export async function syncMediaReferences(
  tx: MediaTransaction,
  ownerType: MediaOwner,
  row: { id: string; deletedAt: Date | null },
): Promise<void> {
  // Never wipe media_references when SUPABASE_URL is absent (e.g. non-storage test/dev env).
  if (env.SUPABASE_URL === undefined) {
    return;
  }
  const existing = await tx
    .select({ id: mediaReferences.uploadId })
    .from(mediaReferences)
    .where(and(eq(mediaReferences.ownerType, ownerType), eq(mediaReferences.ownerId, row.id)));
  const existingIds = new Set(existing.map((r) => r.id));
  // Soft-deleted records are restorable, so retain their referenced images to prevent orphan-sweep loss.
  const paths = [...extractReferencedObjectPaths(collectMediaStrings(row))];
  const uploads =
    paths.length === 0
      ? []
      : await tx
          .select()
          .from(mediaUploads)
          .where(
            and(
              eq(mediaUploads.bucket, env.SUPABASE_STORAGE_BUCKET),
              inArray(mediaUploads.objectPath, paths),
            ),
          );
  if (
    uploads.length !== paths.length ||
    uploads.some(
      (u) =>
        u.deletedAt !== null ||
        u.deletingAt !== null ||
        (u.verifiedAt === null && !existingIds.has(u.id)),
    )
  ) {
    throw new ConflictError(
      'Complete and verify each media upload before attaching it',
      'MEDIA_NOT_VERIFIED',
    );
  }
  // Lock each upload before deciding whether it is still attachable. The orphan
  // sweep takes the same per-upload lock before claiming an unreferenced file.
  for (const upload of uploads) {
    await lockMediaEntity(tx, 'uploads', upload.id);
  }
  const freshUploads =
    uploads.length === 0
      ? []
      : await tx
          .select()
          .from(mediaUploads)
          .where(
            inArray(
              mediaUploads.id,
              uploads.map((upload) => upload.id),
            ),
          );
  if (freshUploads.length !== uploads.length) {
    throw new ConflictError('A referenced media upload disappeared', 'MEDIA_NOT_VERIFIED');
  }

  const nextIds = new Set(freshUploads.map((u) => u.id));
  if (existingIds.size === nextIds.size && [...nextIds].every((id) => existingIds.has(id))) {
    return;
  }
  await tx
    .delete(mediaReferences)
    .where(and(eq(mediaReferences.ownerType, ownerType), eq(mediaReferences.ownerId, row.id)));
  if (uploads.length > 0)
    await tx
      .insert(mediaReferences)
      .values(uploads.map((u) => ({ uploadId: u.id, ownerType, ownerId: row.id })));
}

export async function withMediaMutation<T extends { id: string; deletedAt: Date | null } | null>(
  db: Database,
  owner: MediaOwner,
  ownerId: string,
  mutate: (tx: MediaTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockMediaEntity(tx, owner, ownerId);
    const row = await mutate(tx);
    if (row !== null) await syncMediaReferences(tx, owner, row);
    return row;
  });
}
