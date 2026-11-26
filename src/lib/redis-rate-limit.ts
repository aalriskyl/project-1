import { z } from 'zod';
import { ServiceUnavailableError } from '@/lib/errors.ts';
import { closeRedis, type RedisCommandClient, redisClient } from '@/lib/redis.ts';
import type { RateLimitStore, RateLimitWindowState } from '@/middlewares/rate-limit.ts';

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;
const WindowSchema = z.tuple([z.number().int().positive(), z.number().int().nonnegative()]);

export function createRedisRateLimitStore(client: RedisCommandClient): RateLimitStore {
  return {
    async increment(key: string, windowMs: number): Promise<RateLimitWindowState> {
      try {
        const [count, ttl] = WindowSchema.parse(
          await client.send('EVAL', [INCREMENT_SCRIPT, '1', `rate-limit:${key}`, String(windowMs)]),
        );
        return { count, resetAtMs: Date.now() + ttl };
      } catch {
        throw new ServiceUnavailableError(
          'Rate limiting is temporarily unavailable',
          'RATE_LIMIT_UNAVAILABLE',
        );
      }
    },
  };
}

export const redisRateLimitStore =
  redisClient === undefined ? undefined : createRedisRateLimitStore(redisClient);
export function closeRateLimitStore(): void {
  closeRedis();
}
