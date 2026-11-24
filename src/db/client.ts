import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { env } from '@/config/env.ts';
import * as schema from '@/db/schema/index.ts';

/**
 * Single reusable Postgres connection pool configured for Supabase Supavisor transaction mode:
 * - `prepare: false` is required when connecting through Supavisor transaction pooler (port 6543).
 * - Explicit small pool (`DB_POOL_MAX`) prevents exhausting Supabase connection limits across instances.
 * - SSL is enforced in production.
 */
function resolveSslMode(databaseUrl: string, nodeEnv: string): 'require' | false {
  if (nodeEnv === 'production') {
    return 'require';
  }
  try {
    const parsed = new URL(databaseUrl);
    const sslMode = parsed.searchParams.get('sslmode');
    if (sslMode === 'disable') {
      return false;
    }
    if (
      sslMode === 'require' ||
      parsed.hostname.endsWith('.supabase.com') ||
      parsed.hostname.endsWith('.supabase.co')
    ) {
      return 'require';
    }
  } catch {
    return false;
  }
  return false;
}

export const queryClient: Sql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: env.DB_POOL_MAX,
  idle_timeout: env.DB_IDLE_TIMEOUT_SEC,
  connect_timeout: env.DB_CONNECT_TIMEOUT_SEC,
  ssl: resolveSslMode(env.DATABASE_URL, env.NODE_ENV),
  onnotice: false,
});

export type Database = PostgresJsDatabase<typeof schema>;

export const db: Database = drizzle(queryClient, { schema });

export async function checkDbReadiness(database: Database = db): Promise<boolean> {
  try {
    await database.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
