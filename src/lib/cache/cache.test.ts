import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createRedisCache } from '@/lib/cache/cache.ts';
import { checkRedisReadiness, type RedisCommandClient } from '@/lib/integrations/redis.ts';
import { createCacheInvalidatingNotifier } from '@/lib/integrations/revalidate.ts';
import { createCatalogService } from '@/modules/catalog/catalog.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';

function createFakeRedis(): {
  readonly client: RedisCommandClient;
  readonly kv: Map<string, string>;
  readonly sets: Map<string, Set<string>>;
} {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const client: RedisCommandClient = {
    send(command: string, args: string[]): Promise<unknown> {
      if (command === 'PING') {
        return Promise.resolve('PONG');
      }
      if (command === 'GET') {
        return Promise.resolve(kv.get(args[0] ?? '') ?? null);
      }
      if (command === 'SET') {
        kv.set(args[0] ?? '', args[1] ?? '');
        return Promise.resolve('OK');
      }
      if (command === 'SADD') {
        const key = args[0] ?? '';
        const set = sets.get(key) ?? new Set<string>();
        for (const member of args.slice(1)) {
          set.add(member);
        }
        sets.set(key, set);
        return Promise.resolve(1);
      }
      if (command === 'EXPIRE') {
        return Promise.resolve(1);
      }
      if (command === 'SMEMBERS') {
        return Promise.resolve([...(sets.get(args[0] ?? '') ?? [])]);
      }
      if (command === 'DEL') {
        let deleted = 0;
        for (const key of args) {
          if (kv.delete(key)) deleted += 1;
          if (sets.delete(key)) deleted += 1;
        }
        return Promise.resolve(deleted);
      }
      if (command === 'EVAL') {
        if (String(args[0] ?? '').includes('pruned')) {
          const tagKey = args[2] ?? '';
          const members = sets.get(tagKey);
          if (members !== undefined) {
            for (const member of members) {
              if (!kv.has(member)) members.delete(member);
            }
          }
          return Promise.resolve(0);
        }
        const numKeys = Number(args[1] ?? '0');
        const tagKeys = args.slice(2, 2 + numKeys);
        let deleted = 0;
        for (const tagKey of tagKeys) {
          const members = sets.get(tagKey);
          if (members !== undefined) {
            for (const member of members) {
              if (kv.delete(member)) deleted += 1;
            }
          }
          if (sets.delete(tagKey)) deleted += 1;
        }
        return Promise.resolve(deleted);
      }
      return Promise.resolve(null);
    },
  };

  return { client, kv, sets };
}

describe('Redis readiness & response cache', () => {
  test('checkRedisReadiness handles unset client, PONG, non-PONG, and errors', async () => {
    expect(await checkRedisReadiness(undefined)).toBe(true);

    const { client } = createFakeRedis();
    expect(await checkRedisReadiness(client)).toBe(true);

    const badReplyClient: RedisCommandClient = {
      send: () => Promise.resolve('ERR'),
    };
    expect(await checkRedisReadiness(badReplyClient)).toBe(false);

    const failingClient: RedisCommandClient = {
      send: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    expect(await checkRedisReadiness(failingClient)).toBe(false);
  });

  test('caches JSON with schema validation, invalidates by tag, and fails open on Redis errors', async () => {
    const { client, kv } = createFakeRedis();
    const cache = createRedisCache(client);
    const PayloadSchema = z.object({ count: z.number().int() });

    expect(await cache.getJson('stats', PayloadSchema)).toBeNull();
    await cache.setJson('stats', { count: 42 }, 60, ['categories', 'sitemap']);
    expect(await cache.getJson('stats', PayloadSchema)).toEqual({ count: 42 });

    // Stale/corrupted shape fails validation and returns null (miss)
    kv.set('cache:v1:stats', JSON.stringify({ count: 'not-a-number' }));
    expect(await cache.getJson('stats', PayloadSchema)).toBeNull();

    await cache.setJson('stats', { count: 99 }, 60, ['categories']);
    await cache.invalidateTags(['categories']);
    expect(await cache.getJson('stats', PayloadSchema)).toBeNull();

    // Fail-open when Redis throws
    const brokenCache = createRedisCache({
      send: () => Promise.reject(new Error('Redis down')),
    });
    expect(await brokenCache.getJson('stats', PayloadSchema)).toBeNull();
    await brokenCache.setJson('stats', { count: 1 }, 60, ['categories']);
    await brokenCache.invalidateTags(['categories']);
  });

  test('CatalogService serves cached categories & sitemap and invalidates on admin mutations', async () => {
    const store = createInMemoryDatastore();
    const { client } = createFakeRedis();
    const cache = createRedisCache(client);
    const revalidator = createCacheInvalidatingNotifier(cache);

    let listActiveCalls = 0;
    let sitemapCalls = 0;
    const spiedCatalogRepo = {
      ...store.catalogRepo,
      listActive: (filter?: Parameters<typeof store.catalogRepo.listActive>[0]) => {
        listActiveCalls += 1;
        return store.catalogRepo.listActive(filter);
      },
      listSitemapIndex: () => {
        sitemapCalls += 1;
        return store.catalogRepo.listSitemapIndex();
      },
    };

    const service = createCatalogService(spiedCatalogRepo, revalidator, cache);
    const admin = {
      id: '01936c8e-7f2a-7000-8000-000000000001',
      email: 'a@b.com',
      role: 'admin' as const,
    };

    await service.createCategory(admin, {
      name: 'Genset Silent',
      noIndex: false,
      specSchema: [],
      sortOrder: 0,
    });

    const firstCats = await service.listPublicCategories({ tree: true });
    const secondCats = await service.listPublicCategories({ tree: true });
    expect(firstCats).toHaveLength(1);
    expect(secondCats).toHaveLength(1);
    expect(listActiveCalls).toBe(1);

    const firstMap = await service.getSitemap();
    const secondMap = await service.getSitemap();
    expect(firstMap.categories).toHaveLength(1);
    expect(secondMap.categories).toHaveLength(1);
    expect(sitemapCalls).toBe(1);

    // Admin mutation invalidates both 'categories' and 'sitemap' tags
    await service.createCategory(admin, {
      name: 'Pompa Air',
      noIndex: false,
      specSchema: [],
      sortOrder: 1,
    });
    // Allow microtask queue for void cache.invalidateTags(...)
    await Promise.resolve();
    await Promise.resolve();

    const refreshedCats = await service.listPublicCategories({ tree: true });
    const refreshedMap = await service.getSitemap();
    expect(refreshedCats).toHaveLength(2);
    expect(refreshedMap.categories).toHaveLength(2);
    expect(listActiveCalls).toBe(2);
    expect(sitemapCalls).toBe(2);
  });
});
