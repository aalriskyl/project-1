import { describe, expect, test } from 'bun:test';
import pino from 'pino';
import { encryptMail, decryptMail } from '@/lib/mail-outbox-crypto.ts';
import { createMailProvider } from '@/lib/mailer.ts';
import { createNotificationsService } from '@/modules/notifications/notifications.service.ts';
import type { NotificationsRepository } from '@/modules/notifications/notifications.repository.ts';
import type { MailOutboxRow } from '@/db/schema/mail-outbox.ts';

const key = 'a'.repeat(64);
const email = {
  to: 'ada@example.com',
  displayName: 'Ada',
  resetUrl: 'https://example.com/reset?token=sensitive',
  expiresInMinutes: 30,
};
describe('Durable password-reset delivery', () => {
  test('encrypts reset links and authenticates ciphertext', async () => {
    const payload = await encryptMail(email, key);
    expect(payload).not.toContain('sensitive');
    expect(payload).not.toContain(email.to);
    expect(await decryptMail(payload, key)).toEqual(email);
    await expect(decryptMail(payload, 'b'.repeat(64))).rejects.toThrow();
    await expect(decryptMail(`${payload}.extra`, key)).rejects.toThrow();
  });
  test('retains jobs for retry, reuses idempotency key, and clears successful payloads', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    let row: MailOutboxRow | null = {
      id: '01936c8e-7f2a-7000-8000-000000000111',
      payload: await encryptMail(email, key),
      attempts: 1,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1800000),
      nextAttemptAt: now,
      leaseId: '01936c8e-7f2a-7000-8000-000000000112',
      leaseUntil: new Date(now.getTime() + 30000),
      finishedAt: null,
    };
    const retries: Date[] = [];
    const finished: string[] = [];
    const keys: (string | undefined)[] = [];
    const repo: NotificationsRepository = {
      claim: () => Promise.resolve(row),
      retry(_id, _lease, next) {
        retries.push(next);
        return Promise.resolve();
      },
      finish(id) {
        finished.push(id);
        row = null;
        return Promise.resolve();
      },
    };
    let fail = true;
    const service = createNotificationsService(
      repo,
      {
        sendPasswordResetEmail(input) {
          keys.push(input.idempotencyKey);
          return fail ? Promise.reject(new Error('provider failure')) : Promise.resolve();
        },
      },
      key,
      pino({ level: 'silent' }),
      () => now,
    );
    expect(await service.processNext()).toBe(true);
    expect(retries[0]?.getTime()).toBe(now.getTime() + 5000);
    expect(finished).toHaveLength(0);
    fail = false;
    expect(await service.processNext()).toBe(true);
    expect(finished).toHaveLength(1);
    expect(keys[0]).toBe(keys[1]);
    expect(await service.processNext()).toBe(false);
  });
  test('throws on missing credentials and non-success delivery responses', async () => {
    await expect(
      createMailProvider({ from: 'noreply@example.com' }).sendPasswordResetEmail(email),
    ).rejects.toMatchObject({ code: 'MAIL_NOT_CONFIGURED' });
    const mockFetch: typeof fetch = Object.assign(
      () => Promise.resolve(new Response(null, { status: 429 })),
      { preconnect: fetch.preconnect },
    );
    await expect(
      createMailProvider({
        from: 'noreply@example.com',
        apiKey: 'test-only-key',
        fetch: mockFetch,
      }).sendPasswordResetEmail(email),
    ).rejects.toMatchObject({ code: 'MAIL_DELIVERY_FAILED' });
  });
});
