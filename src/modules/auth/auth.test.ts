import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { hashTokenSha256 } from '@/lib/auth/crypto.ts';
import {
  ConflictError,
  ErrorResponseSchema,
  ForbiddenError,
  UnauthorizedError,
} from '@/lib/shared/errors.ts';
import type { GoogleTokenVerifier } from '@/lib/integrations/google-oauth.ts';
import { generateId } from '@/lib/auth/id.ts';
import { hashPassword } from '@/lib/auth/password.ts';
import type { PasswordResetEmailInput } from '@/lib/integrations/mailer.ts';
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
    expect(stored?.passwordHash?.startsWith('$argon2id$')).toBe(true);

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

  test('rejects deactivated accounts across login, refresh, reset and Google sign-in', async () => {
    const store = createInMemoryDatastore();
    const inactiveId = generateId();
    const rawRefreshToken = 'inactive-user-refresh-token-value';
    await store.authRepo.insertRefreshToken({
      id: generateId(),
      userId: inactiveId,
      familyId: generateId(),
      tokenHash: hashTokenSha256(rawRefreshToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    store.seedUser({
      id: inactiveId,
      email: 'inactive@example.com',
      passwordHash: await hashPassword('correct-horse-battery-staple'),
      displayName: 'Inactive User',
      isActive: false,
    });

    const sentEmails: PasswordResetEmailInput[] = [];
    const service = createAuthService(store.authRepo, {
      mailer: {
        sendPasswordResetEmail(input) {
          sentEmails.push(input);
          return Promise.resolve();
        },
        sendInquiryEmail() {
          return Promise.resolve();
        },
      },
      googleVerifier: {
        verifyIdToken: () =>
          Promise.resolve({
            sub: 'inactive-google-sub',
            email: 'inactive@example.com',
            displayName: 'Inactive User',
          }),
      },
    });
    const actor = { id: inactiveId, email: 'inactive@example.com', role: 'user' as const };

    await expect(
      service.login({ email: 'inactive@example.com', password: 'correct-horse-battery-staple' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.refresh({ refreshToken: rawRefreshToken })).rejects.toMatchObject({
      code: 'ACCOUNT_INACTIVE',
    });
    expect((await service.forgotPassword({ email: 'inactive@example.com' })).message).toContain(
      'If an account exists',
    );
    expect(sentEmails).toHaveLength(0);
    await expect(service.googleLogin({ idToken: 'any-google-token' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      service.changePassword(actor, {
        currentPassword: 'correct-horse-battery-staple',
        newPassword: 'brand-new-password-123',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('Auth HTTP routes (/v1/auth — register, login, google, forgot/reset, refresh, logout)', () => {
  function setupTestApp(authRateLimitMax: number = 30) {
    const store = createInMemoryDatastore();
    const sentEmails: PasswordResetEmailInput[] = [];

    const mockGoogleVerifier: GoogleTokenVerifier = {
      verifyIdToken(idToken) {
        if (idToken === 'valid-google-token-new-user') {
          return Promise.resolve({
            sub: 'google-sub-1001',
            email: 'ken@example.com',
            displayName: 'Ken Thompson',
          });
        }
        if (idToken === 'valid-google-token-existing-ada') {
          return Promise.resolve({
            sub: 'google-sub-ada-1',
            email: 'ada@example.com',
            displayName: 'Ada Lovelace',
          });
        }
        if (idToken === 'valid-google-token-different-sub-ada') {
          return Promise.resolve({
            sub: 'google-sub-ada-impostor',
            email: 'ada@example.com',
            displayName: 'Other Sub',
          });
        }
        return Promise.reject(
          new UnauthorizedError('Invalid Google token', 'INVALID_GOOGLE_TOKEN'),
        );
      },
    };

    const testApp = createApp({
      authService: createAuthService(store.authRepo, {
        googleVerifier: mockGoogleVerifier,
        mailer: {
          sendPasswordResetEmail(input) {
            sentEmails.push(input);
            return Promise.resolve();
          },
          sendInquiryEmail() {
            return Promise.resolve();
          },
        },
      }),
      usersService: createUsersService(store.usersRepo),
      checkReadiness: () => Promise.resolve(true),
      authRateLimitMax,
    });

    return { testApp, sentEmails, store };
  }

  test('POST /login rejects a deactivated account with 403 ACCOUNT_INACTIVE', async () => {
    const { testApp, store } = setupTestApp();
    store.seedUser({
      id: generateId(),
      email: 'deactivated@example.com',
      passwordHash: await hashPassword('correct-horse-battery-staple'),
      displayName: 'Deactivated User',
      isActive: false,
    });

    const res = await testApp.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'deactivated@example.com',
        password: 'correct-horse-battery-staple',
      }),
    });
    expect(res.status).toBe(403);
    expect(ErrorResponseSchema.parse(await res.json()).errorCode).toBe('ACCOUNT_INACTIVE');
  });

  test('POST /register, /login, /google account linking, /forgot-password + /reset-password session revocation, and /logout', async () => {
    const { testApp, sentEmails } = setupTestApp();

    const registerRes = await testApp.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'Ada@Example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'Ada Lovelace',
        phone: '+6281234567890',
      }),
    });

    expect(registerRes.status).toBe(201);
    const registerJson = AuthSessionEnvelopeSchema.parse(await registerRes.json());
    expect(registerJson.data.user.email).toBe('ada@example.com');
    expect(registerJson.data.user.phone).toBe('+6281234567890');

    // Google Sign-In creates a Google-only account and blocks password login on it
    const googleNewRes = await testApp.request('/v1/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'valid-google-token-new-user' }),
    });
    expect(googleNewRes.status).toBe(200);
    const googleNew = AuthSessionEnvelopeSchema.parse(await googleNewRes.json());
    expect(googleNew.data.user.email).toBe('ken@example.com');

    const pwLoginOnGoogleOnly = await testApp.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ken@example.com', password: 'any-password-12345' }),
    });
    expect(pwLoginOnGoogleOnly.status).toBe(401);

    const implicitLink = await testApp.request('/v1/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'valid-google-token-existing-ada' }),
    });
    expect(implicitLink.status).toBe(409);
    const linkRequest = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'valid-google-token-existing-ada' }),
    };
    expect((await testApp.request('/v1/auth/google/link', linkRequest)).status).toBe(401);
    expect(
      (
        await testApp.request('/v1/auth/google/link', {
          ...linkRequest,
          headers: {
            ...linkRequest.headers,
            Authorization: `Bearer ${googleNew.data.tokens.accessToken}`,
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await testApp.request('/v1/auth/google/link', {
          ...linkRequest,
          headers: {
            ...linkRequest.headers,
            Authorization: `Bearer ${registerJson.data.tokens.accessToken}`,
          },
          body: JSON.stringify({ idToken: 'short' }),
        })
      ).status,
    ).toBe(422);
    const googleLinkRes = await testApp.request('/v1/auth/google/link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${registerJson.data.tokens.accessToken}`,
      },
      body: JSON.stringify({ idToken: 'valid-google-token-existing-ada' }),
    });
    expect(googleLinkRes.status).toBe(200);

    const googleMismatchRes = await testApp.request('/v1/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'valid-google-token-different-sub-ada' }),
    });
    expect(googleMismatchRes.status).toBe(409);

    // Forgot password -> Reset password revokes Ada's active refresh token & is single-use
    const forgotRes = await testApp.request('/v1/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com' }),
    });
    expect(forgotRes.status).toBe(202);
    expect(sentEmails).toHaveLength(1);

    const resetLink = new URL(sentEmails[0]?.resetUrl ?? 'http://localhost');
    const rawResetToken = resetLink.searchParams.get('token') ?? '';

    const resetRes = await testApp.request('/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: rawResetToken,
        newPassword: 'brand-new-secure-password-999',
      }),
    });
    expect(resetRes.status).toBe(204);

    // Reusing consumed reset token fails with 401
    const replayResetRes = await testApp.request('/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: rawResetToken,
        newPassword: 'another-password-9999',
      }),
    });
    expect(replayResetRes.status).toBe(401);

    // Existing refresh token from before password reset must now be revoked!
    const refreshOldSessionRes = await testApp.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: registerJson.data.tokens.refreshToken }),
    });
    expect(refreshOldSessionRes.status).toBe(401);

    // Login with new password succeeds
    const newLoginRes = await testApp.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ada@example.com',
        password: 'brand-new-secure-password-999',
      }),
    });
    expect(newLoginRes.status).toBe(200);
    const newLoginJson = AuthSessionEnvelopeSchema.parse(await newLoginRes.json());

    // Change password: wrong current password -> 401
    const wrongCurrentPwRes = await testApp.request('/v1/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${newLoginJson.data.tokens.accessToken}`,
      },
      body: JSON.stringify({
        currentPassword: 'not-the-right-password',
        newPassword: 'another-brand-new-password-111',
      }),
    });
    expect(wrongCurrentPwRes.status).toBe(401);

    // Change password: new password identical to current -> 422
    const samePwRes = await testApp.request('/v1/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${newLoginJson.data.tokens.accessToken}`,
      },
      body: JSON.stringify({
        currentPassword: 'brand-new-secure-password-999',
        newPassword: 'brand-new-secure-password-999',
      }),
    });
    expect(samePwRes.status).toBe(422);

    // Change password: Google-only user (no password hash) -> 409 PASSWORD_NOT_SET
    const googleOnlyChangePwRes = await testApp.request('/v1/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${googleNew.data.tokens.accessToken}`,
      },
      body: JSON.stringify({
        currentPassword: 'any-current-password-123',
        newPassword: 'another-brand-new-password-222',
      }),
    });
    expect(googleOnlyChangePwRes.status).toBe(409);

    // Change password: valid -> 204 and revokes active refresh tokens
    const changePwRes = await testApp.request('/v1/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${newLoginJson.data.tokens.accessToken}`,
      },
      body: JSON.stringify({
        currentPassword: 'brand-new-secure-password-999',
        newPassword: 'final-rotated-password-2026',
      }),
    });
    expect(changePwRes.status).toBe(204);

    // Refresh token and access token issued prior to password change are immediately revoked -> 401
    const revokedAccessRes = await testApp.request('/v1/users/me', {
      headers: { Authorization: `Bearer ${newLoginJson.data.tokens.accessToken}` },
    });
    expect(revokedAccessRes.status).toBe(401);

    const revokedAfterChangeRes = await testApp.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: newLoginJson.data.tokens.refreshToken }),
    });
    expect(revokedAfterChangeRes.status).toBe(401);

    // Login with the newly changed password succeeds
    const finalLoginRes = await testApp.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ada@example.com',
        password: 'final-rotated-password-2026',
      }),
    });
    expect(finalLoginRes.status).toBe(200);
    const finalLoginJson = AuthSessionEnvelopeSchema.parse(await finalLoginRes.json());

    const logoutRes = await testApp.request('/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: finalLoginJson.data.tokens.refreshToken }),
    });
    expect(logoutRes.status).toBe(204);
  });

  test('returns 422 on weak password or unknown strict fields and 429 when auth rate limit exceeded', async () => {
    const { testApp } = setupTestApp(2);

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
    expect(invalidJson.success).toBe(false);
    expect(invalidJson.errorCode).toBe('VALIDATION_ERROR');
    expect(invalidJson.details?.length).toBeGreaterThan(0);

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
    expect(Number(thirdRes.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});
