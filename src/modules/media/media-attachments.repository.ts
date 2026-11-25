import { and, eq, inArray, sql } from 'drizzle-orm';
import { env } from '@/config/env.ts';
import type { Database } from '@/db/client.ts';
import { mediaReferences, mediaUploads } from '@/db/schema/media-uploads.ts';
import { extractReferencedObjectPaths } from '@/lib/asset-url.ts';
import { ConflictError } from '@/lib/errors.ts';

export type MediaTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type MediaOwner = 'products' | 'categories' | 'articles';

// Shared by attachment commits, upload completion and deletion claims. No network I/O under this lock.
export async function lockMediaLifecycle(tx: MediaTransaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(724193, 1)`);
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
  const existing = await tx
    .select({ id: mediaReferences.uploadId })
    .from(mediaReferences)
    .where(and(eq(mediaReferences.ownerType, ownerType), eq(mediaReferences.ownerId, row.id)));
  const existingIds = new Set(existing.map((r) => r.id));
  const paths =
    row.deletedAt !== null || env.SUPABASE_URL === undefined
      ? []
      : [...extractReferencedObjectPaths(collectMediaStrings(row))];
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
  mutate: (tx: MediaTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockMediaLifecycle(tx);
    const row = await mutate(tx);
    if (row !== null) await syncMediaReferences(tx, owner, row);
    return row;
  });
}
