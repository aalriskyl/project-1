import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { RateLimitError } from '@/lib/errors.ts';
import type { AppEnv } from '@/types/app.ts';

export interface RateLimitWindowState {
  readonly count: number;
  readonly resetAtMs: number;
}

/**
 * Pluggable rate-limit backing store.
 * Swap `InMemoryRateLimitStore` for a Redis-backed implementation (`INCR` + `PEXPIRE`)
 * when running multiple horizontally scaled instances.
 */
export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitWindowState>;
}

interface BucketEntry {
  count: number;
  resetAtMs: number;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketEntry>();
  private operationsSinceSweep = 0;

  public increment(key: string, windowMs: number): Promise<RateLimitWindowState> {
    const now = Date.now();
    this.maybeSweepExpired(now);

    const existing = this.buckets.get(key);
    if (existing === undefined || existing.resetAtMs <= now) {
      const fresh: BucketEntry = { count: 1, resetAtMs: now + windowMs };
      this.buckets.set(key, fresh);
      return Promise.resolve({ count: fresh.count, resetAtMs: fresh.resetAtMs });
    }

    existing.count += 1;
    return Promise.resolve({ count: existing.count, resetAtMs: existing.resetAtMs });
  }

  private maybeSweepExpired(now: number): void {
    this.operationsSinceSweep += 1;
    if (this.operationsSinceSweep < 500) {
      return;
    }
    this.operationsSinceSweep = 0;
    for (const [bucketKey, entry] of this.buckets.entries()) {
      if (entry.resetAtMs <= now) {
        this.buckets.delete(bucketKey);
      }
    }
  }
}

export interface RateLimiterOptions {
  readonly windowMs: number;
  readonly max: number;
  readonly keyPrefix: string;
  readonly store?: RateLimitStore;
  readonly trustProxy?: boolean;
  readonly keyGenerator?: (c: Context<AppEnv>) => string;
}

function defaultClientKey(c: Context<AppEnv>, trustProxy: boolean): string {
  const user = c.get('user');
  if (user !== undefined) {
    return `user:${user.id}`;
  }

  if (trustProxy) {
    const forwardedFor = c.req.header('x-forwarded-for');
    const firstIp = forwardedFor?.split(',')[0]?.trim();
    if (firstIp !== undefined && firstIp.length > 0) {
      return `ip:${firstIp}`;
    }
  }

  const realIp = c.req.header('x-real-ip')?.trim();
  if (realIp !== undefined && realIp.length > 0) {
    return `ip:${realIp}`;
  }

  return 'ip:anonymous';
}

export function createRateLimiter(options: RateLimiterOptions) {
  const store = options.store ?? new InMemoryRateLimitStore();
  const trustProxy = options.trustProxy ?? false;

  return createMiddleware<AppEnv>(async (c, next) => {
    const clientId =
      options.keyGenerator !== undefined
        ? options.keyGenerator(c)
        : defaultClientKey(c, trustProxy);
    const key = `${options.keyPrefix}:${clientId}`;

    const state = await store.increment(key, options.windowMs);
    const remaining = Math.max(0, options.max - state.count);
    const resetSec = Math.max(1, Math.ceil((state.resetAtMs - Date.now()) / 1000));

    c.header('RateLimit-Limit', String(options.max));
    c.header('RateLimit-Remaining', String(remaining));
    c.header('RateLimit-Reset', String(resetSec));

    if (state.count > options.max) {
      throw new RateLimitError(resetSec);
    }

    await next();
  });
}
