import { describe, expect, test } from 'bun:test';
import { createApp } from '@/app.ts';
import type { InquiryRow } from '@/db/schema/inquiries.ts';
import { signAccessToken } from '@/lib/auth/jwt.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import {
  type InquiriesRepository,
  type InquiryListFilter,
} from '@/modules/inquiries/inquiries.repository.ts';
import { createInquiriesService } from '@/modules/inquiries/inquiries.service.ts';
import { createUsersService } from '@/modules/users/users.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';
import type { AuthUser, UserRole } from '@/types/app.ts';

const admin: AuthUser = {
  id: '01936c8e-7f2a-7000-8000-000000000901',
  email: 'admin@tsuzumi.test',
  role: 'admin',
};

class FakeInquiriesRepository implements InquiriesRepository {
  readonly rows = new Map<string, InquiryRow>();

  findByIdempotencyKey(key: string): Promise<InquiryRow | null> {
    return Promise.resolve(
      [...this.rows.values()].find((row) => row.idempotencyKey === key) ?? null,
    );
  }

  findById(id: string): Promise<InquiryRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  createWithDelivery(input: Parameters<InquiriesRepository['createWithDelivery']>[0]) {
    const now = new Date();
    const row: InquiryRow = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  listCursor({ limit, filter }: { limit: number; filter?: InquiryListFilter | undefined }) {
    const rows = [...this.rows.values()]
      .filter((row) => (filter?.status === undefined ? true : row.status === filter.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    return Promise.resolve(rows);
  }

  listOffset({ limit, offset }: { limit: number; offset: number }) {
    const rows = [...this.rows.values()];
    return Promise.resolve({ items: rows.slice(offset, offset + limit), total: rows.length });
  }

  updateStatus(id: string, status: InquiryRow['status'], now: Date) {
    const row = this.rows.get(id);
    if (row === undefined) return Promise.resolve(null);
    const updated = { ...row, status, updatedAt: now };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }
}

async function setup() {
  const store = createInMemoryDatastore();
  store.seedUser({
    id: admin.id,
    email: admin.email,
    passwordHash: 'hash',
    displayName: 'Admin',
    role: 'admin' as UserRole,
  });
  const repo = new FakeInquiriesRepository();
  const inquiryService = createInquiriesService({
    inquiriesRepo: repo,
    productsRepo: { findActiveByIds: () => Promise.resolve([]) },
  });
  const token = (await signAccessToken(admin)).token;
  store.seedUser({
    id: '01936c8e-7f2a-7000-8000-000000000902',
    email: 'user@tsuzumi.test',
    passwordHash: 'hash',
    displayName: 'Regular User',
    role: 'user' as UserRole,
  });
  const userToken = (
    await signAccessToken({
      id: '01936c8e-7f2a-7000-8000-000000000902',
      email: 'user@tsuzumi.test',
      role: 'user',
    })
  ).token;
  const testApp = createApp({
    authService: createAuthService(store.authRepo),
    usersService: createUsersService(store.usersRepo),
    inquiryService,
    checkReadiness: () => Promise.resolve(true),
  });
  return { testApp, repo, token, userToken };
}

const body = {
  name: 'Andi Saputra',
  email: 'andi@example.com',
  phone: '+628123456789',
  message: 'Saya ingin penawaran harga genset 30 kVA untuk proyek industri.',
};

describe('Inquiries module', () => {
  test('submits with idempotency and rejects invalid input', async () => {
    const { testApp, repo } = await setup();
    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'rfq-01936c8e-7f2a-7000-8000-000000000401',
    };

    const first = await testApp.request('/v1/inquiries', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string } };
    expect(firstBody.data.id).toBeDefined();

    const retry = await testApp.request('/v1/inquiries', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const retryBody = (await retry.json()) as { data: { id: string } };
    expect(retryBody.data.id).toBe(firstBody.data.id);
    expect(repo.rows.size).toBe(1);

    const mismatched = await testApp.request('/v1/inquiries', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, message: `${body.message} Updated` }),
    });
    expect(mismatched.status).toBe(409);

    const invalid = await testApp.request('/v1/inquiries', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'rfq-other-key-123' },
      body: JSON.stringify({ ...body, message: 'short' }),
    });
    expect(invalid.status).toBe(422);

    const missingKey = await testApp.request('/v1/inquiries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(missingKey.status).toBe(422);
  });

  test('enforces admin access and supports status updates', async () => {
    const { testApp, repo, token, userToken } = await setup();
    expect((await testApp.request('/v1/admin/inquiries')).status).toBe(401);
    expect(
      (
        await testApp.request('/v1/admin/inquiries', {
          headers: { Authorization: `Bearer ${userToken}` },
        })
      ).status,
    ).toBe(403);

    const submitted = await testApp.request('/v1/inquiries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'rfq-admin-flow-001',
      },
      body: JSON.stringify(body),
    });
    const id = ((await submitted.json()) as { data: { id: string } }).data.id;

    const list = await testApp.request('/v1/admin/inquiries', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);

    const updated = await testApp.request(`/v1/admin/inquiries/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'contacted' }),
    });
    expect(updated.status).toBe(200);
    expect(repo.rows.get(id)?.status).toBe('contacted');
  });
});
