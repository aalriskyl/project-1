import { defineConfig } from 'drizzle-kit';

function normalizeMigrationUrl(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined || rawUrl.length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(rawUrl);
    if (
      !parsed.searchParams.has('sslmode') &&
      (parsed.hostname.endsWith('.supabase.com') || parsed.hostname.endsWith('.supabase.co'))
    ) {
      parsed.searchParams.set('sslmode', 'require');
      return parsed.toString();
    }
  } catch {
    return rawUrl;
  }
  return rawUrl;
}

const directUrl = normalizeMigrationUrl(process.env['DIRECT_URL']);
// `generate` diffs snapshots offline; only commands that connect need a URL.
if (directUrl === undefined && process.argv.includes('migrate')) {
  throw new Error('DIRECT_URL is required for drizzle-kit migrations (set it in .env)');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  ...(directUrl !== undefined ? { dbCredentials: { url: directUrl } } : {}),
  verbose: true,
  strict: true,
});
