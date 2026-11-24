import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { ConflictError, ErrorResponseSchema, UnauthorizedError } from '@/lib/errors.ts';
import { AuthSessionEnvelopeSchema } from '@/modules/auth/auth.schema.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';

describe('AuthService (unit)', () => {
  test('registers user with Argon2id hash, rotates refresh token, and revokes family on token replay', async () => {
    const store = createInMemoryDatastore();
    const service = createAuthService(store.authRepo);

    const initial = await service.register({
      email: 'ada@example.com',
      password: 'correct-horse-battery-staple',
      displayName: 'Ada Lovelace',
    });

    expect(initial.user.email).toBe('ada@example.com');
    expect(initial.tokens.tokenType).toBe('Bearer');

    const stored = await store.authRepo.findUserByEmailWithCredentials('ada@example.com');
    expect(stored).not.toBeNull();
    expect(stored?.passwordHash).not.toBe('correct-horse-battery-staple');
    expect(stored?.passwordHash.startsWith('$argon2id$')).toBe(true);

    const rotated = await service.refresh({
      refreshToken: initial.tokens.refreshToken,
    });
    expect(rotated.tokens.refreshToken).not.toBe(initial.tokens.refreshToken);

    // Replaying the already-rotated token must fail AND revoke the entire token family.
    await expect(
      service.refresh({ refreshToken: initial.tokens.refreshToken }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // The descendant token in the compromised family must now also be rejected.
    await expect(
      service.refresh({ refreshToken: rotated.tokens.refreshToken }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test('rejects duplicate registration and invalid credentials', async () => {
    const store = createInMemoryDatastore();
    const service = createAuthService(store.authRepo);

    await service.register({
      email: 'grace@example.com',
      password: 'correct-horse-battery-staple',
      displayName: 'Grace Hopper',
    });

    await expect(
      service.register({
        email: 'grace@example.com',
        password: 'another-valid-password-123',
        displayName: 'Grace Duplicate',
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(
      service.login({
        email: 'grace@example.com',
        password: 'wrong-password-attempt',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    await expect(
      service.login({
        email: 'nobody@example.com',
        password: 'wrong-password-attempt',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test('rejects expired refresh tokens', async () => {
    const store = createInMemoryDatastore();
    const expiredService = createAuthService(store.authRepo, { refreshTokenTtlSec: -10 });

    const session = await expiredService.register({
      email: 'linus@example.com',
      password: 'correct-horse-battery-staple',
      displayName: 'Linus',
    });

    await expect(
      expiredService.refresh({ refreshToken: session.tokens.refreshToken }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('Auth HTTP routes (/v1/auth)', () => {
  function setupTestApp(authRateLimitMax: number = 20) {
    const store = createInMemoryDatastore();
    return createApp({
      authService: createAuthService(store.authRepo),
      usersService: createUsersService(store.usersRepo),
      checkReadiness: () => Promise.resolve(true),
      authRateLimitMax,
    });
  }

  test('POST /v1/auth/register, /login, /refresh, /logout full lifecycle', async () => {
    const testApp = setupTestApp();

    const registerRes = await testApp.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'Ada@Example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'Ada Lovelace',
      }),
    });

    expect(registerRes.status).toBe(201);
    const registerJson = AuthSessionEnvelopeSchema.parse(await registerRes.json());
    expect(registerJson.data.user.email).toBe('ada@example.com');

    const duplicateRes = await testApp.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ada@example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'Ada Lovelace',
      }),
    });
    expect(duplicateRes.status).toBe(409);

    const loginRes = await testApp.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ada@example.com',
        password: 'correct-horse-battery-staple',
      }),
    });
    expect(loginRes.status).toBe(200);

    const logoutRes = await testApp.request('/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: registerJson.data.tokens.refreshToken,
      }),
    });
    expect(logoutRes.status).toBe(204);

    const refreshAfterLogoutRes = await testApp.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: registerJson.data.tokens.refreshToken,
      }),
    });
    expect(refreshAfterLogoutRes.status).toBe(401);
  });

  test('returns 422 on weak password or unknown strict fields and 429 when auth rate limit exceeded', async () => {
    const testApp = setupTestApp(2);

    const invalidRes = await testApp.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ada@example.com',
        password: 'short',
        displayName: 'Ada',
        role: 'admin',
      }),
    });
    expect(invalidRes.status).toBe(422);
    const invalidJson = ErrorResponseSchema.parse(await invalidRes.json());
    expect(invalidJson.error.code).toBe('VALIDATION_ERROR');
    expect(invalidJson.error.details?.length).toBeGreaterThan(0);

    const secondRes = await testApp.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bad', password: 'x' }),
    });
    expect(secondRes.status).toBe(422);

    const thirdRes = await testApp.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'password' }),
    });
    expect(thirdRes.status).toBe(429);
    expect(thirdRes.headers.get('Retry-After')).not.toBeNull();
  });
});
