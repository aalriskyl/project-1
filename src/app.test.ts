import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';
import { createApp } from '@/app.ts';
import { parseEnv } from '@/config/env.ts';
import * as schema from '@/db/schema/index.ts';
import { ErrorResponseSchema } from '@/lib/errors.ts';
import { createAuthRepository } from '@/modules/auth/auth.repository.ts';
import { AuthSessionEnvelopeSchema } from '@/modules/auth/auth.schema.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { createUsersRepository } from '@/modules/users/users.repository.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';

const OpenApiSummarySchema = z.object({
  openapi: z.string(),
  paths: z.record(z.string(), z.unknown()),
  components: z.object({
    securitySchemes: z.record(z.string(), z.unknown()),
  }),
});

describe('Application core invariants', () => {
  test('GET /health, GET /ready (200 & 503), GET /v1/openapi.json, and 404 envelope', async () => {
    const store = createInMemoryDatastore();
    let dbHealthy = true;

    const testApp = createApp({
      authService: createAuthService(store.authRepo),
      usersService: createUsersService(store.usersRepo),
      checkReadiness: () => Promise.resolve(dbHealthy),
    });

    const healthRes = await testApp.request('/health', {
      headers: { 'X-Request-Id': 'req-valid_123' },
    });
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get('X-Request-Id')).toBe('req-valid_123');
    expect(healthRes.headers.get('X-Content-Type-Options')).toBe('nosniff');

    // Unsafe incoming X-Request-Id must be replaced rather than reflected.
    const unsafeIdRes = await testApp.request('/health', {
      headers: { 'X-Request-Id': 'bad id with spaces!' },
    });
    expect(unsafeIdRes.headers.get('X-Request-Id')).not.toBe('bad id with spaces!');

    const readyOk = await testApp.request('/ready');
    expect(readyOk.status).toBe(200);

    dbHealthy = false;
    const readyDown = await testApp.request('/ready');
    expect(readyDown.status).toBe(503);

    const openApiRes = await testApp.request('/v1/openapi.json');
    expect(openApiRes.status).toBe(200);
    const spec = OpenApiSummarySchema.parse(await openApiRes.json());
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/v1/auth/register']).toBeDefined();
    expect(spec.paths['/v1/users/me']).toBeDefined();
    expect(spec.components.securitySchemes['BearerAuth']).toBeDefined();

    const notFoundRes = await testApp.request('/v1/does-not-exist');
    expect(notFoundRes.status).toBe(404);
    const notFoundBody = ErrorResponseSchema.parse(await notFoundRes.json());
    expect(notFoundBody.error.code).toBe('ROUTE_NOT_FOUND');
  });

  test('enforces CORS allowlist, body size limit, and hides internal SQL/stack errors on 500', async () => {
    const store = createInMemoryDatastore();
    const failingApp = createApp({
      authService: createAuthService(store.authRepo),
      usersService: createUsersService(store.usersRepo),
      checkReadiness: () =>
        Promise.reject(new Error('SELECT password_hash FROM users WHERE secret = 1')),
      maxBodyBytes: 64,
    });

    const allowedCors = await failingApp.request('/health', {
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(allowedCors.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');

    const disallowedCors = await failingApp.request('/health', {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(disallowedCors.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const oversizedRes = await failingApp.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'x'.repeat(200) }),
    });
    expect(oversizedRes.status).toBe(413);

    const internalErrRes = await failingApp.request('/ready');
    expect(internalErrRes.status).toBe(500);
    const rawText = await internalErrRes.text();
    expect(rawText).not.toContain('password_hash');
    expect(rawText).not.toContain('SELECT');
  });

  test('parseEnv rejects wildcard CORS, short JWT secrets, and invalid DB URLs', () => {
    const validBase = {
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/db',
      CORS_ORIGINS: 'http://localhost:3000',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
    };

    expect(() => parseEnv(validBase)).not.toThrow();
    expect(() => parseEnv({ ...validBase, CORS_ORIGINS: '*' })).toThrow();
    expect(() => parseEnv({ ...validBase, JWT_ACCESS_SECRET: 'too-short' })).toThrow();
    expect(() => parseEnv({ ...validBase, DATABASE_URL: 'mysql://localhost/db' })).toThrow();
  });
});

const liveTestDbUrl = process.env['TEST_DATABASE_URL'];

describe.skipIf(!liveTestDbUrl)('PostgreSQL integration suite (real test DB)', () => {
  test('verifies RLS enabled on public tables and runs end-to-end auth + users flow', async () => {
    if (!liveTestDbUrl) {
      return;
    }

    const client = postgres(liveTestDbUrl, { prepare: false, max: 2, onnotice: false });
    const testDb = drizzle(client, { schema });

    try {
      const expectedTables = [
        'users',
        'refresh_tokens',
        'categories',
        'articles',
        'products',
        'product_spareparts',
        'media_uploads',
        'password_reset_tokens',
        'product_reviews',
      ];
      const rlsRows = await testDb.execute<{ tablename: string; rowsecurity: boolean }>(sql`
        select tablename, rowsecurity
        from pg_tables
        where schemaname = 'public' and tablename in (
          'users',
          'refresh_tokens',
          'categories',
          'articles',
          'products',
          'product_spareparts',
          'media_uploads',
          'password_reset_tokens',
          'product_reviews'
        )
      `);
      expect(rlsRows.length).toBe(expectedTables.length);
      for (const row of rlsRows) {
        expect(row.rowsecurity).toBe(true);
      }

      const liveApp = createApp({
        authService: createAuthService(createAuthRepository(testDb)),
        usersService: createUsersService(createUsersRepository(testDb)),
        checkReadiness: async () => {
          await testDb.execute(sql`select 1`);
          return true;
        },
      });

      const uniqueEmail = `itest-${Date.now()}@example.com`;
      const regRes = await liveApp.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: uniqueEmail,
          password: 'correct-horse-battery-staple',
          displayName: 'Integration User',
        }),
      });
      expect(regRes.status).toBe(201);
      const regJson = AuthSessionEnvelopeSchema.parse(await regRes.json());

      const meRes = await liveApp.request('/v1/users/me', {
        headers: { Authorization: `Bearer ${regJson.data.tokens.accessToken}` },
      });
      expect(meRes.status).toBe(200);
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
