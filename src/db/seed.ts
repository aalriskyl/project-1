import { env } from '@/config/env.ts';
import { closeDb, type Database, db } from '@/db/client.ts';
import { seedArticles } from '@/db/seeders/articles.seeder.ts';
import { seedCategories } from '@/db/seeders/categories.seeder.ts';
import { seedProducts } from '@/db/seeders/products.seeder.ts';
import { seedReviews } from '@/db/seeders/reviews.seeder.ts';
import type { SeedSummary } from '@/db/seeders/types.ts';
import { seedUsers } from '@/db/seeders/users.seeder.ts';
import { logger } from '@/lib/logging/logger.ts';

export type SeederName = 'users' | 'categories' | 'products' | 'articles' | 'reviews';

const ALL_SEEDERS: readonly SeederName[] = [
  'users',
  'categories',
  'products',
  'articles',
  'reviews',
];

function parseOnlyFlag(argv: readonly string[]): ReadonlySet<SeederName> {
  const arg = argv.find((entry) => entry.startsWith('--only='));
  if (arg === undefined) {
    return new Set(ALL_SEEDERS);
  }

  const rawNames = arg
    .slice('--only='.length)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  const selected = new Set<SeederName>();
  for (const name of rawNames) {
    if (
      name === 'users' ||
      name === 'categories' ||
      name === 'products' ||
      name === 'articles' ||
      name === 'reviews'
    ) {
      selected.add(name);
    } else {
      throw new Error(`Unknown seeder "${name}". Valid values: ${ALL_SEEDERS.join(', ')}`);
    }
  }

  // Ensure FK prerequisites are included automatically when running a single downstream seeder.
  if (selected.has('reviews')) {
    selected.add('users');
    selected.add('categories');
    selected.add('products');
  }
  if (selected.has('articles')) {
    selected.add('users');
    selected.add('categories');
    selected.add('products');
  }
  if (selected.has('products')) {
    selected.add('categories');
  }

  return selected;
}

/**
 * Orchestrates modular domain seeders under `src/db/seeders/` in foreign-key order.
 * Supports running all seeders (`bun run db:seed`) or a subset (`bun run db:seed --only=products`).
 */
export async function seedDatabase(
  database: Database,
  selected: ReadonlySet<SeederName> = new Set(ALL_SEEDERS),
): Promise<SeedSummary> {
  if (env.NODE_ENV === 'production' && process.env['SEED_ALLOW_PRODUCTION'] !== 'true') {
    throw new Error(
      'Refusing to run dev seeder in production without SEED_ALLOW_PRODUCTION=true and explicit credentials',
    );
  }

  const adminEmail = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@tsuzumi.test';
  const adminPassword = process.env['SEED_ADMIN_PASSWORD'] ?? 'TsuzumiAdmin2026!';
  const customerEmail = process.env['SEED_USER_EMAIL'] ?? 'customer@tsuzumi.test';
  const customerPassword = process.env['SEED_USER_PASSWORD'] ?? 'TsuzumiUser2026!';

  if (env.NODE_ENV === 'production' && process.env['SEED_ADMIN_PASSWORD'] === undefined) {
    throw new Error('SEED_ADMIN_PASSWORD must be explicitly set when seeding in production');
  }

  const usersResult = selected.has('users')
    ? await seedUsers(database, {
        adminEmail,
        adminPassword,
        customerEmail,
        customerPassword,
        ...(env.NODE_ENV !== 'production'
          ? {
              devSuperAdmin: {
                email: process.env['SEED_SUPERADMIN_EMAIL'] ?? 'superadmin@pelangi.com',
                password: process.env['SEED_SUPERADMIN_PASSWORD'] ?? '123',
              },
            }
          : {}),
      })
    : null;

  const categoriesResult = selected.has('categories') ? await seedCategories(database) : null;

  const productsResult =
    selected.has('products') && categoriesResult !== null
      ? await seedProducts(database, categoriesResult.idsByKey)
      : null;

  const articlesResult =
    selected.has('articles') && usersResult !== null && productsResult !== null
      ? await seedArticles(database, usersResult.adminId, productsResult.idsByKey)
      : null;

  const reviewsResult =
    selected.has('reviews') && usersResult !== null && productsResult !== null
      ? await seedReviews(
          database,
          { primary: usersResult.reviewerId, secondary: usersResult.customerId },
          productsResult.idsByKey,
        )
      : null;

  return {
    usersEnsured: usersResult?.count ?? 0,
    categoriesEnsured: categoriesResult?.count ?? 0,
    productsEnsured: productsResult?.productsCount ?? 0,
    sparepartLinksEnsured: productsResult?.sparepartLinksCount ?? 0,
    articlesEnsured: articlesResult?.count ?? 0,
    reviewsEnsured: reviewsResult?.count ?? 0,
  };
}

if (import.meta.main) {
  try {
    const selected = parseOnlyFlag(process.argv.slice(2));
    const summary = await seedDatabase(db, selected);
    logger.info({ summary, seeders: [...selected] }, 'Database seed completed');
    if (env.NODE_ENV !== 'production') {
      const adminEmail = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@tsuzumi.test';
      const customerEmail = process.env['SEED_USER_EMAIL'] ?? 'customer@tsuzumi.test';
      console.log('\nSeeded Tsuzumi Japan dataset (idempotent):', JSON.stringify(summary));
      if (selected.has('users')) {
        const superAdminEmail = process.env['SEED_SUPERADMIN_EMAIL'] ?? 'superadmin@pelangi.com';
        console.log(`  Superadmin:     ${superAdminEmail} (dev-only)`);
        console.log(`  Admin login:    ${adminEmail} (env SEED_ADMIN_PASSWORD or dev default)`);
        console.log(`  Customer login: ${customerEmail} (env SEED_USER_PASSWORD or dev default)`);
      }
    }
  } finally {
    await closeDb();
  }
}
