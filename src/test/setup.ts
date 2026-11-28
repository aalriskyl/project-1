// Preloaded by bunfig.toml during `bun test`.
// Explicitly overrides local `.env` values so tests remain deterministic and never connect to a real Supabase project.
process.env['NODE_ENV'] = 'test';
process.env['HOST'] = '127.0.0.1';
process.env['PORT'] = '0';
process.env['LOG_LEVEL'] = 'silent';
process.env['CORS_ORIGINS'] = 'http://localhost:3000,http://localhost:5173';
process.env['MAX_BODY_BYTES'] = '1048576';
process.env['REQUEST_TIMEOUT_MS'] = '5000';
process.env['RATE_LIMIT_WINDOW_MS'] = '60000';
process.env['RATE_LIMIT_MAX'] = '100';
process.env['AUTH_RATE_LIMIT_MAX'] = '10';
if (
  process.env['CI'] === 'true' &&
  (!process.env['TEST_DATABASE_URL'] || !process.env['TEST_REDIS_URL'])
) {
  throw new Error(
    'CI must provide non-empty TEST_DATABASE_URL and TEST_REDIS_URL; otherwise integration suites silently skip',
  );
}
if (process.env['TEST_DATABASE_URL']) {
  const testUrl = new URL(process.env['TEST_DATABASE_URL']);
  if (
    !['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(testUrl.hostname) ||
    !testUrl.pathname.endsWith('_test')
  )
    throw new Error('TEST_DATABASE_URL must target a local database ending in _test');
}
process.env['DATABASE_URL'] =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:5432/project_1_test';
process.env['DB_POOL_MAX'] = '2';
process.env['DB_IDLE_TIMEOUT_SEC'] = '5';
process.env['DB_CONNECT_TIMEOUT_SEC'] = '2';
process.env['JWT_ACCESS_SECRET'] = 'test-only-access-secret-minimum-32-characters-long';
process.env['JWT_ISSUER'] = 'project-1-api-test';
process.env['JWT_AUDIENCE'] = 'project-1-client-test';
process.env['JWT_ACCESS_TTL_SEC'] = '900';
process.env['REFRESH_TOKEN_TTL_SEC'] = '604800';
// Never inherit external service credentials or Redis connections from a developer's .env.
for (const name of [
  'REDIS_URL',
  'RESEND_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOOGLE_OAUTH_CLIENT_ID',
  'NEXTJS_REVALIDATE_URL',
  'NEXTJS_REVALIDATE_SECRET',
  'MAIL_OUTBOX_ENCRYPTION_KEY',
])
  Reflect.deleteProperty(process.env, name);
process.env['SUPABASE_URL'] = 'https://example.supabase.co';
process.env['SUPABASE_STORAGE_BUCKET'] = 'public-assets';
process.env['TRUSTED_PROXY_IPS'] = '';
