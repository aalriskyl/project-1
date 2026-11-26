import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createRateLimiter } from '@/middlewares/rate-limit.ts';
import { errorHandler } from '@/middlewares/error-handler.ts';
import { createRedisRateLimitStore } from '@/lib/redis-rate-limit.ts';
import type { AppEnv } from '@/types/app.ts';

describe('Rate-limit client identity', () => {
  function setup(trustedProxyIps: string[] = []) {
    const app = new Hono<AppEnv>();
    app.use(
      '*',
      createRateLimiter({ max: 1, windowMs: 60_000, keyPrefix: 'test', trustedProxyIps }),
    );
    app.get('/', (c) => c.text('ok'));
    app.onError(errorHandler);
    return app;
  }
  test('ignores forged proxy headers and separates real connections', async () => {
    const app = setup();
    expect(
      (await app.request('/', { headers: { 'X-Real-IP': '1.1.1.1' } }, { clientIp: '203.0.113.1' }))
        .status,
    ).toBe(200);
    const blocked = await app.request(
      '/',
      { headers: { 'X-Real-IP': '8.8.8.8', 'X-Forwarded-For': '9.9.9.9' } },
      { clientIp: '203.0.113.1' },
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await app.request('/', {}, { clientIp: '203.0.113.2' })).status).toBe(200);
  });
  test('accepts overwritten X-Real-IP only from a configured proxy', async () => {
    const app = setup(['127.0.0.1']);
    for (const ip of ['203.0.113.1', '203.0.113.2'])
      expect(
        (await app.request('/', { headers: { 'X-Real-IP': ip } }, { clientIp: '127.0.0.1' }))
          .status,
      ).toBe(200);
    expect(
      (
        await app.request(
          '/',
          { headers: { 'X-Real-IP': '203.0.113.1' } },
          { clientIp: '127.0.0.1' },
        )
      ).status,
    ).toBe(429);
    expect(
      (await app.request('/', { headers: { 'X-Real-IP': 'invalid' } }, { clientIp: '127.0.0.1' }))
        .status,
    ).toBe(200);
    expect((await app.request('/', {}, { clientIp: '127.0.0.1' })).status).toBe(429);
  });
  test('fails closed on Redis failures or malformed counters', async () => {
    const valid = createRedisRateLimitStore({ send: () => Promise.resolve([2, 500]) });
    expect((await valid.increment('ip:test', 1000)).count).toBe(2);
    for (const send of [
      () => Promise.resolve('invalid'),
      () => Promise.reject(new Error('connection lost')),
    ]) {
      await expect(
        createRedisRateLimitStore({ send }).increment('ip:test', 1000),
      ).rejects.toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
    }
  });
});
