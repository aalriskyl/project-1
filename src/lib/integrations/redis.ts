import { RedisClient } from 'bun';
import { env } from '@/config/env.ts';

export interface RedisCommandClient {
  send(command: string, args: string[]): Promise<unknown>;
}

const REDIS_CONNECT_TIMEOUT_MS = 2_000;

export const redisClient =
  env.REDIS_URL === undefined
    ? undefined
    : new RedisClient(env.REDIS_URL, {
        connectionTimeout: REDIS_CONNECT_TIMEOUT_MS,
        maxRetries: 1,
      });

/**
 * Verifies Redis connectivity via `PING`. Returns `true` when Redis is not configured
 * (development fallback), or when `PING` replies `PONG`.
 */
export async function checkRedisReadiness(
  client: RedisCommandClient | undefined = redisClient,
): Promise<boolean> {
  if (client === undefined) {
    return true;
  }
  try {
    const reply = await client.send('PING', []);
    return reply === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await redisClient?.close();
}
