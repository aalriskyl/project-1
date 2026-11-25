import { RedisClient } from 'bun';
import { z } from 'zod';
import { env } from '@/config/env.ts';
import { ServiceUnavailableError } from '@/lib/errors.ts';
import type { RateLimitStore, RateLimitWindowState } from '@/middlewares/rate-limit.ts';

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;
const WindowSchema = z.tuple([z.number().int().positive(), z.number().int().nonnegative()]);
interface RedisCommands {
  send(command: string, args: string[]): Promise<unknown>;
}

export function createRedisRateLimitStore(client: RedisCommands): RateLimitStore {
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

const redis =
  env.REDIS_URL === undefined
    ? undefined
    : new RedisClient(env.REDIS_URL, { connectionTimeout: 2000, maxRetries: 1 });
export const redisRateLimitStore =
  redis === undefined ? undefined : createRedisRateLimitStore(redis);
export function closeRateLimitStore(): void {
  redis?.close();
}
