import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import { ForbiddenError, NotFoundError } from '@/lib/errors.ts';
import { generateId } from '@/lib/id.ts';
import { signAccessToken } from '@/lib/jwt.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { UserCursorPageSchema, UserEnvelopeSchema } from '@/modules/users/users.schema.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';

describe('UsersService (unit)', () => {
  test('enforces ownership on getUserById (prevents IDOR) and admin role on listUsers', async () => {
    const store = createInMemoryDatastore();
    const service = createUsersService(store.usersRepo);

    const alice = store.seedUser({
      id: generateId(),
      email: 'alice@example.com',
      passwordHash: 'hash',
      displayName: 'Alice',
      role: 'user',
    });
    const bob = store.seedUser({
      id: generateId(),
      email: 'bob@example.com',
      passwordHash: 'hash',
      displayName: 'Bob',
      role: 'user',
    });
    const admin = store.seedUser({
      id: generateId(),
      email: 'admin@example.com',
      passwordHash: 'hash',
      displayName: 'Admin',
      role: 'admin',
    });

    const ownProfile = await service.getUserById(
      { id: alice.id, email: alice.email, role: 'user' },
      alice.id,
    );
    expect(ownProfile.id).toBe(alice.id);

    await expect(
      service.getUserById({ id: alice.id, email: alice.email, role: 'user' }, bob.id),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const adminView = await service.getUserById(
      { id: admin.id, email: admin.email, role: 'admin' },
      bob.id,
    );
    expect(adminView.id).toBe(bob.id);

    await expect(
      service.listUsers({ id: alice.id, email: alice.email, role: 'user' }, { limit: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      service.getMe({ id: generateId(), email: 'ghost@example.com', role: 'user' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Users HTTP routes (/v1/users)', () => {
  async function setupFixture() {
    const store = createInMemoryDatastore();
    const t0 = new Date('2026-11-24T01:00:00.000Z');
    const t1 = new Date('2026-11-24T02:00:00.000Z');
    const t2 = new Date('2026-11-24T03:00:00.000Z');

    const user1 = store.seedUser({
      id: '01936c8e-7f2a-7000-8000-000000000001',
      email: 'user1@example.com',
      passwordHash: 'hash',
      displayName: 'User One',
      role: 'user',
      createdAt: t0,
    });
    const user2 = store.seedUser({
      id: '01936c8e-7f2a-7000-8000-000000000002',
      email: 'user2@example.com',
      passwordHash: 'hash',
      displayName: 'User Two',
      role: 'user',
      createdAt: t1,
    });
    const admin = store.seedUser({
      id: '01936c8e-7f2a-7000-8000-000000000003',
      email: 'admin@example.com',
      passwordHash: 'hash',
      displayName: 'Admin User',
      role: 'admin',
      createdAt: t2,
    });

    const user1Token = (await signAccessToken({ id: user1.id, email: user1.email, role: 'user' }))
      .token;
    const adminToken = (await signAccessToken({ id: admin.id, email: admin.email, role: 'admin' }))
      .token;

    const testApp = createApp({
      authService: createAuthService(store.authRepo),
      usersService: createUsersService(store.usersRepo),
      checkReadiness: () => Promise.resolve(true),
    });

    return { testApp, user1, user2, admin, user1Token, adminToken };
  }

  test('requires valid bearer token and blocks tampered/wrong-issuer tokens', async () => {
    const { testApp, user1 } = await setupFixture();

    const unauthRes = await testApp.request('/v1/users/me');
    expect(unauthRes.status).toBe(401);

    const wrongIssuerToken = (
      await signAccessToken(
        { id: user1.id, email: user1.email, role: 'user' },
        {
          secret: process.env['JWT_ACCESS_SECRET'] ?? 'fallback-secret-at-least-32-characters',
          issuer: 'wrong-issuer',
          audience: process.env['JWT_AUDIENCE'] ?? 'project-1-client-test',
          accessTtlSec: 900,
        },
      )
    ).token;

    const badIssuerRes = await testApp.request('/v1/users/me', {
      headers: { Authorization: `Bearer ${wrongIssuerToken}` },
    });
    expect(badIssuerRes.status).toBe(401);
  });

  test('supports GET /me, PATCH /me (displayName & E.164 phone), IDOR 403 on /{id}, and cursor pagination', async () => {
    const { testApp, user1, user2, user1Token, adminToken } = await setupFixture();

    const meRes = await testApp.request('/v1/users/me', {
      headers: { Authorization: `Bearer ${user1Token}` },
    });
    expect(meRes.status).toBe(200);

    const extraFieldPatch = await testApp.request('/v1/users/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${user1Token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Updated', role: 'admin' }),
    });
    expect(extraFieldPatch.status).toBe(422);

    const badPhonePatch = await testApp.request('/v1/users/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${user1Token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone: '08123456' }),
    });
    expect(badPhonePatch.status).toBe(422);

    const emptyPatch = await testApp.request('/v1/users/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${user1Token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(emptyPatch.status).toBe(422);

    const validPatch = await testApp.request('/v1/users/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${user1Token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'User One Updated', phone: '+6281299998888' }),
    });
    expect(validPatch.status).toBe(200);
    const patchedBody = UserEnvelopeSchema.parse(await validPatch.json());
    expect(patchedBody.data.displayName).toBe('User One Updated');
    expect(patchedBody.data.phone).toBe('+6281299998888');

    const idorRes = await testApp.request(`/v1/users/${user2.id}`, {
      headers: { Authorization: `Bearer ${user1Token}` },
    });
    expect(idorRes.status).toBe(403);

    const invalidUuidRes = await testApp.request('/v1/users/not-a-uuid', {
      headers: { Authorization: `Bearer ${user1Token}` },
    });
    expect(invalidUuidRes.status).toBe(422);

    // Cursor pagination as admin (limit=2 across 3 users)
    const page1Res = await testApp.request('/v1/users?limit=2', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(page1Res.status).toBe(200);
    const page1 = UserCursorPageSchema.parse(await page1Res.json());
    expect(page1.data).toHaveLength(2);
    expect(page1.meta.hasMore).toBe(true);
    expect(page1.meta.nextCursor).not.toBeNull();

    const page2Res = await testApp.request(
      `/v1/users?limit=2&cursor=${encodeURIComponent(page1.meta.nextCursor ?? '')}`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );
    expect(page2Res.status).toBe(200);
    const page2 = UserCursorPageSchema.parse(await page2Res.json());
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0]?.id).toBe(user1.id);
    expect(page2.meta.hasMore).toBe(false);

    const overLimitRes = await testApp.request('/v1/users?limit=500', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(overLimitRes.status).toBe(422);

    const badCursorRes = await testApp.request('/v1/users?cursor=invalid-cursor', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(badCursorRes.status).toBe(422);
  });
});
