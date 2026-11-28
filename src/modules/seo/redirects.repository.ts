import { and, eq } from 'drizzle-orm';
import { db, type Database } from '@/db/client.ts';
import { slugRedirects } from '@/db/schema/redirects.ts';
import { type StructuredDataType, StructuredDataTypeSchema } from '@/modules/seo/seo.schema.ts';

export interface RedirectRecord {
  readonly entityType: StructuredDataType;
  readonly oldSlug: string;
  readonly newSlug: string;
  readonly createdAt: string;
}

export interface RedirectRepository {
  /** Removes any redirect whose old slug is being claimed by a newly created entity. */
  claimSlug(entityType: StructuredDataType, slug: string): Promise<void>;
  /** Records `oldSlug -> newSlug` and repoints redirects that previously targeted `oldSlug`. */
  recordSlugChange(entityType: StructuredDataType, oldSlug: string, newSlug: string): Promise<void>;
  findByOldSlug(entityType: StructuredDataType, oldSlug: string): Promise<RedirectRecord | null>;
}

export const noopRedirectRepository: RedirectRepository = {
  claimSlug: () => Promise.resolve(),
  recordSlugChange: () => Promise.resolve(),
  findByOldSlug: () => Promise.resolve(null),
};

export function createRedirectRepository(database: Database = db): RedirectRepository {
  return {
    async claimSlug(entityType, slug): Promise<void> {
      await database
        .delete(slugRedirects)
        .where(and(eq(slugRedirects.entityType, entityType), eq(slugRedirects.oldSlug, slug)));
    },

    async recordSlugChange(entityType, oldSlug, newSlug): Promise<void> {
      if (oldSlug === newSlug) return;

      // Drop a mapping that would point back to a slug which is live again.
      await database
        .delete(slugRedirects)
        .where(and(eq(slugRedirects.entityType, entityType), eq(slugRedirects.oldSlug, newSlug)));

      // Collapse chains: anything that used to point at oldSlug now points at newSlug.
      await database
        .update(slugRedirects)
        .set({ newSlug })
        .where(and(eq(slugRedirects.entityType, entityType), eq(slugRedirects.newSlug, oldSlug)));

      await database
        .insert(slugRedirects)
        .values({ entityType, oldSlug, newSlug })
        .onConflictDoUpdate({
          target: [slugRedirects.entityType, slugRedirects.oldSlug],
          set: { newSlug, createdAt: new Date() },
        });
    },

    async findByOldSlug(entityType, oldSlug): Promise<RedirectRecord | null> {
      const [row] = await database
        .select()
        .from(slugRedirects)
        .where(and(eq(slugRedirects.entityType, entityType), eq(slugRedirects.oldSlug, oldSlug)))
        .limit(1);
      if (row === undefined) return null;
      return {
        entityType: StructuredDataTypeSchema.parse(row.entityType),
        oldSlug: row.oldSlug,
        newSlug: row.newSlug,
        createdAt: row.createdAt.toISOString(),
      };
    },
  };
}
