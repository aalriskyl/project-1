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
