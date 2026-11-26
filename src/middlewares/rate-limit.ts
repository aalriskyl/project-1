import type { Context } from 'hono';
import { isIP } from 'node:net';
import { env } from '@/config/env.ts';
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
  readonly trustedProxyIps?: readonly string[];
  readonly keyGenerator?: (c: Context<AppEnv>) => string;
}

function normalizeIpAddress(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  // Strip IPv4-mapped IPv6 prefix (e.g. ::ffff:10.0.0.1 -> 10.0.0.1)
  if (trimmed.startsWith('::ffff:')) {
    const ipv4Part = trimmed.slice('::ffff:'.length);
    if (isIP(ipv4Part) === 4) {
      return ipv4Part;
    }
  }
  return trimmed;
}

function normalizeRateLimitIpKey(rawIp: string): string {
  const normalized = normalizeIpAddress(rawIp);
  if (isIP(normalized) !== 6) {
    return normalized;
  }
  // Bucket IPv6 clients by /64 prefix to prevent trivial address rotation within one allocation.
  const [left = '', right] = normalized.split('::');
  const leftGroups = left.length > 0 ? left.split(':') : [];
  const rightGroups = right !== undefined && right.length > 0 ? right.split(':') : [];
  const missing = 8 - (leftGroups.length + rightGroups.length);
  const full =
    right !== undefined && missing >= 0
      ? [...leftGroups, ...Array<string>(missing).fill('0'), ...rightGroups]
      : leftGroups;
  const prefix64 = full
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':');
  return `${prefix64}::/64`;
}

function defaultClientKey(c: Context<AppEnv>, trustedProxyIps: readonly string[]): string {
  const rawPeer = c.env?.clientIp;
  const peer = rawPeer !== undefined ? normalizeIpAddress(rawPeer) : undefined;
  // The final proxy must overwrite X-Real-IP; never trust an arbitrary forwarded chain.
  if (
    peer !== undefined &&
    trustedProxyIps.some((trusted) => normalizeIpAddress(trusted) === peer)
  ) {
    const realIp = c.req.header('x-real-ip')?.trim();
    if (realIp !== undefined && isIP(realIp) !== 0) {
      return `ip:${normalizeRateLimitIpKey(realIp)}`;
    }
  }
  return `ip:${peer !== undefined ? normalizeRateLimitIpKey(peer) : 'unknown'}`;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const store = options.store ?? new InMemoryRateLimitStore();
  const trustedProxyIps = options.trustedProxyIps ?? env.TRUSTED_PROXY_IPS;

  return createMiddleware<AppEnv>(async (c, next) => {
    const clientId =
      options.keyGenerator !== undefined
        ? options.keyGenerator(c)
        : defaultClientKey(c, trustedProxyIps);
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
