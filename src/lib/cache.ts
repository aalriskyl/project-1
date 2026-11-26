import type { z } from 'zod';
import { logger } from '@/lib/logger.ts';
import { type RedisCommandClient, redisClient } from '@/lib/redis.ts';

export interface ResponseCache {
  getJson<T>(key: string, schema: z.ZodType<T>): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSec: number, tags?: readonly string[]): Promise<void>;
  invalidateTags(tags: readonly string[]): Promise<void>;
}

const CACHE_KEY_PREFIX = 'cache:v1:';
const TAG_KEY_PREFIX = 'cache:v1:tag:';
const TAG_EXTRA_TTL_SEC = 60;

// Atomically read & delete all keys associated with one or more tag sets.
const INVALIDATE_TAGS_SCRIPT = `
local deleted = 0
for i = 1, #KEYS do
  local members = redis.call('SMEMBERS', KEYS[i])
  if #members > 0 then
    deleted = deleted + redis.call('DEL', unpack(members))
  end
  deleted = deleted + redis.call('DEL', KEYS[i])
end
return deleted
`;

export const noopCache: ResponseCache = {
  getJson: () => Promise.resolve(null),
  setJson: () => Promise.resolve(),
  invalidateTags: () => Promise.resolve(),
};

/**
 * Fail-open Redis JSON cache with schema validation and tag-based invalidation
 * (`SADD` / `SMEMBERS` + `DEL`). Errors or schema mismatches fall back to Postgres cleanly.
 */
export function createRedisCache(client: RedisCommandClient): ResponseCache {
  return {
    async getJson<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
      try {
        const raw = await client.send('GET', [`${CACHE_KEY_PREFIX}${key}`]);
        if (typeof raw !== 'string') {
          return null;
        }
        const parsed = schema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          logger.warn({ key }, 'redis cache entry failed schema validation; ignoring stale value');
          return null;
        }
        return parsed.data;
      } catch (err: unknown) {
        logger.warn({ err, key }, 'redis cache read failed; falling back to database');
        return null;
      }
    },

    async setJson(
      key: string,
      value: unknown,
      ttlSec: number,
      tags: readonly string[] = [],
    ): Promise<void> {
      const fullKey = `${CACHE_KEY_PREFIX}${key}`;
      const serialized = JSON.stringify(value);
      const boundedTtl = Math.max(1, Math.floor(ttlSec));

      try {
        await client.send('SET', [fullKey, serialized, 'EX', String(boundedTtl)]);
        const uniqueTags = [...new Set(tags.filter((t) => t.length > 0))];
        await Promise.all(
          uniqueTags.map(async (tag) => {
            const tagKey = `${TAG_KEY_PREFIX}${tag}`;
            await client.send('SADD', [tagKey, fullKey]);
            await client.send('EXPIRE', [tagKey, String(boundedTtl + TAG_EXTRA_TTL_SEC), 'GT']);
          }),
        );
      } catch (err: unknown) {
        logger.warn({ err, key, tags }, 'redis cache write failed');
      }
    },

    async invalidateTags(tags: readonly string[]): Promise<void> {
      const uniqueTags = [...new Set(tags.filter((t) => t.length > 0))];
      if (uniqueTags.length === 0) {
        return;
      }

      try {
        const tagKeys = uniqueTags.map((tag) => `${TAG_KEY_PREFIX}${tag}`);
        await client.send('EVAL', [INVALIDATE_TAGS_SCRIPT, String(tagKeys.length), ...tagKeys]);
      } catch (err: unknown) {
        logger.warn({ err, tags: uniqueTags }, 'redis cache tag invalidation failed');
      }
    },
  };
}

export const responseCache: ResponseCache =
  redisClient === undefined ? noopCache : createRedisCache(redisClient);
