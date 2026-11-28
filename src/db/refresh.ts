import { sql } from 'drizzle-orm';
import { env } from '@/config/env.ts';
import { closeDb, type Database, db } from '@/db/client.ts';
import { seedDatabase } from '@/db/seed.ts';
import type { SeedSummary } from '@/db/seeders/types.ts';
import { logger } from '@/lib/logging/logger.ts';

/**
 * Truncates all application tables in `public` (preserving schema, RLS, indexes, and
 * `drizzle.__drizzle_migrations`) and immediately re-runs the modular seeders.
 *
 * Unconditionally blocked in `production`.
 */
export async function refreshDatabase(database: Database): Promise<SeedSummary> {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to run db:refresh in production');
  }

  await database.execute(sql`
    TRUNCATE TABLE
      public.product_reviews,
      public.product_spareparts,
      public.articles,
      public.products,
      public.categories,
      public.media_uploads,
      public.media_references,
      public.mail_outbox,
      public.password_reset_tokens,
      public.refresh_tokens,
      public.slug_redirects,
      public.users
    RESTART IDENTITY CASCADE
  `);

  return seedDatabase(database);
}

if (import.meta.main) {
  const confirmed =
    process.argv.slice(2).includes('--yes') || process.env['DB_REFRESH_CONFIRM'] === 'true';

  if (!confirmed) {
    console.error(
      'Aborted: db:refresh will wipe all rows in public application tables and re-seed.\n' +
        'Re-run with --yes to confirm: bun run db:refresh -- --yes',
    );
    process.exit(1);
  }

  try {
    const summary = await refreshDatabase(db);
    logger.info({ summary }, 'Database refresh and re-seed completed');
    console.log('\nRefreshed & re-seeded Tsuzumi Japan dataset:', JSON.stringify(summary));
  } finally {
    await closeDb();
  }
}
