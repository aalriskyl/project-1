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
      body: JSON.stringify({
        name: 'User One Updated',
        phone: '+6281299998888',
        address: 'Jl. Industri Raya No. 45, Bekasi',
      }),
    });
    expect(validPatch.status).toBe(200);
    const patchedBody = UserEnvelopeSchema.parse(await validPatch.json());
    expect(patchedBody.data.name).toBe('User One Updated');
    expect(patchedBody.data.displayName).toBe('User One Updated');
    expect(patchedBody.data.phone).toBe('+6281299998888');
    expect(patchedBody.data.address).toBe('Jl. Industri Raya No. 45, Bekasi');

    // Admin can update user name, email, phone, and address via PATCH /v1/users/:id
    const adminUpdateRes = await testApp.request(`/v1/users/${user2.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'User Two Renamed',
        email: 'user2.updated@example.com',
        phone: '+6281300001111',
        address: 'Jl. Raya Darmo No. 88, Surabaya',
      }),
    });
    expect(adminUpdateRes.status).toBe(200);
    const adminUpdated = UserEnvelopeSchema.parse(await adminUpdateRes.json()).data;
    expect(adminUpdated.name).toBe('User Two Renamed');
    expect(adminUpdated.email).toBe('user2.updated@example.com');
    expect(adminUpdated.phone).toBe('+6281300001111');
    expect(adminUpdated.address).toBe('Jl. Raya Darmo No. 88, Surabaya');

    // Duplicate email update returns 409
    const dupEmailUpdate = await testApp.request(`/v1/users/${user2.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: user1.email }),
    });
    expect(dupEmailUpdate.status).toBe(409);

    // Admin cannot demote own role (409), can promote user2 to admin (200), and can create staff users (201)
    expect(
      (
        await testApp.request('/v1/users/01936c8e-7f2a-7000-8000-000000000003', {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'user' }),
        })
      ).status,
    ).toBe(409);

    const promoteRes = await testApp.request(`/v1/users/${user2.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(promoteRes.status).toBe(200);
    expect(UserEnvelopeSchema.parse(await promoteRes.json()).data.role).toBe('admin');

    expect(
      (
        await testApp.request('/v1/users', {
          method: 'POST',
          headers: { Authorization: `Bearer ${user1Token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'forbidden.staff@example.com',
            password: 'staff-strong-passphrase-2026',
            name: 'Forbidden Staff',
            role: 'admin',
          }),
        })
      ).status,
    ).toBe(403);

    const createStaffRes = await testApp.request('/v1/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'staff@example.com',
        password: 'staff-strong-passphrase-2026',
        name: 'Tsuzumi Staff',
        phone: '+6281122334455',
        address: 'Jakarta Pusat',
        role: 'admin',
      }),
    });
    expect(createStaffRes.status).toBe(201);
    const createdStaff = UserEnvelopeSchema.parse(await createStaffRes.json()).data;
    expect(createdStaff.role).toBe('admin');
    expect(createdStaff.name).toBe('Tsuzumi Staff');
    expect(createdStaff.address).toBe('Jakarta Pusat');

    const idorRes = await testApp.request(`/v1/users/${user2.id}`, {
      headers: { Authorization: `Bearer ${user1Token}` },
    });
    expect(idorRes.status).toBe(403);

    const invalidUuidRes = await testApp.request('/v1/users/not-a-uuid', {
      headers: { Authorization: `Bearer ${user1Token}` },
    });
    expect(invalidUuidRes.status).toBe(422);

    // Cursor pagination as admin (limit=2 across 4 users)
    const page1Res = await testApp.request('/v1/users?limit=2', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(page1Res.status).toBe(200);
    const page1 = UserCursorPageSchema.parse(await page1Res.json());
    expect(page1.data).toHaveLength(2);
    expect(page1.data.some((u) => u.id === createdStaff.id)).toBe(true);
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
    expect(page2.data).toHaveLength(2);
    expect(page2.data.some((u) => u.id === user1.id)).toBe(true);
    expect(page2.meta.hasMore).toBe(false);

    const overLimitRes = await testApp.request('/v1/users?limit=500', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(overLimitRes.status).toBe(422);

    const badCursorRes = await testApp.request('/v1/users?cursor=invalid-cursor', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(badCursorRes.status).toBe(422);

    // Admin users date-range filter (invalid range -> 422, future -> 0) and address search
    expect(
      (
        await testApp.request('/v1/users?createdFrom=2030-02-01&createdTo=2030-01-01', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).status,
    ).toBe(422);

    const futureUsers = UserCursorPageSchema.parse(
      await (
        await testApp.request('/v1/users?createdFrom=2099-01-01', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(futureUsers.data).toHaveLength(0);

    const usersByAddress = UserCursorPageSchema.parse(
      await (
        await testApp.request('/v1/users?q=Jakarta', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(usersByAddress.data.some((u) => u.id === createdStaff.id)).toBe(true);

    // Non-admin cannot delete users (403); admin cannot delete self (409)
    expect(
      (
        await testApp.request(`/v1/users/${user2.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${user1Token}` },
        })
      ).status,
    ).toBe(403);

    const adminSelfDel = await testApp.request('/v1/users/01936c8e-7f2a-7000-8000-000000000003', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(adminSelfDel.status).toBe(409);

    // Admin soft-deletes user1 -> status='inactive', user1 blocked on /me (403), filterable & restorable via PATCH
    const delUserRes = await testApp.request(`/v1/users/${user1.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delUserRes.status).toBe(204);

    expect(
      (
        await testApp.request('/v1/users/me', {
          headers: { Authorization: `Bearer ${user1Token}` },
        })
      ).status,
    ).toBe(403);

    const inactiveUsers = UserCursorPageSchema.parse(
      await (
        await testApp.request('/v1/users?status=inactive', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    );
    expect(inactiveUsers.data).toHaveLength(1);
    expect(inactiveUsers.data[0]?.id).toBe(user1.id);
    expect(inactiveUsers.data[0]?.status).toBe('inactive');
    expect(inactiveUsers.data[0]?.deletedAt).not.toBeNull();

    const restoreUserRes = await testApp.request(`/v1/users/${user1.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(restoreUserRes.status).toBe(200);
    const restoredUser = UserEnvelopeSchema.parse(await restoreUserRes.json()).data;
    expect(restoredUser.status).toBe('active');
    expect(restoredUser.deletedAt).toBeNull();

    // Regression C1: token issued before deactivation stays revoked (401) even after restore
    expect(
      (
        await testApp.request('/v1/users/me', {
          headers: { Authorization: `Bearer ${user1Token}` },
        })
      ).status,
    ).toBe(401);

    // Fresh token matching current tokenVersion succeeds on /v1/users/me
    const freshUser1Token = (
      await signAccessToken({
        id: user1.id,
        email: user1.email,
        role: 'user',
        tokenVersion: 2,
      })
    ).token;
    expect(
      (
        await testApp.request('/v1/users/me', {
          headers: { Authorization: `Bearer ${freshUser1Token}` },
        })
      ).status,
    ).toBe(200);

    // Regression H1 & C1: demote extra admins cleanly; cannot demote/deactivate the last active admin (409)
    const staffToken = (
      await signAccessToken({
        id: createdStaff.id,
        email: createdStaff.email,
        role: 'admin',
        tokenVersion: 1,
      })
    ).token;
    expect(
      (
        await testApp.request(`/v1/users/${user2.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'user' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await testApp.request(`/v1/users/${createdStaff.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'user' }),
        })
      ).status,
    ).toBe(200);
    // Demoted admin's previously issued JWT is immediately rejected (401 TOKEN_REVOKED)
    expect(
      (
        await testApp.request('/v1/users', {
          headers: { Authorization: `Bearer ${staffToken}` },
        })
      ).status,
    ).toBe(401);
  });
});
