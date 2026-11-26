import { env } from '@/config/env.ts';
import { type ResponseCache, responseCache } from '@/lib/cache.ts';
import { logger } from '@/lib/logger.ts';

export interface RevalidateNotifier {
  notify(tags: readonly string[]): Promise<void>;
}

export interface NextJsRevalidateConfig {
  readonly url?: string;
  readonly secret?: string;
  readonly timeoutMs?: number;
}

const REVALIDATE_TIMEOUT_MS = 3_000;

/**
 * Non-blocking webhook notifier that triggers Next.js `revalidateTag(...)` when
 * catalog, product, or SEO article records are mutated by an admin.
 */
export function createNextJsRevalidateNotifier(
  config: NextJsRevalidateConfig = {
    ...(env.NEXTJS_REVALIDATE_URL !== undefined ? { url: env.NEXTJS_REVALIDATE_URL } : {}),
    ...(env.NEXTJS_REVALIDATE_SECRET !== undefined ? { secret: env.NEXTJS_REVALIDATE_SECRET } : {}),
  },
): RevalidateNotifier {
  return {
    notify(tags: readonly string[]): Promise<void> {
      const uniqueTags = [...new Set(tags.filter((tag) => tag.length > 0))];
      if (config.url === undefined || uniqueTags.length === 0) {
        return Promise.resolve();
      }

      const targetUrl = config.url;
      const timeoutMs = config.timeoutMs ?? REVALIDATE_TIMEOUT_MS;

      // The external webhook is deliberately non-blocking; only local cache invalidation
      // is awaited by callers so read-after-write never observes stale API responses.
      void fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.secret !== undefined ? { 'X-Revalidate-Secret': config.secret } : {}),
        },
        body: JSON.stringify({ tags: uniqueTags }),
        signal: AbortSignal.timeout(timeoutMs),
      })
        .then((res) => {
          if (!res.ok) {
            logger.warn(
              { status: res.status, tags: uniqueTags },
              'nextjs revalidate webhook returned non-2xx status',
            );
          }
        })
        .catch((err: unknown) => {
          logger.warn({ err, tags: uniqueTags }, 'nextjs revalidate webhook request failed');
        });
      return Promise.resolve();
    },
  };
}

export function createCompositeRevalidateNotifier(
  notifiers: readonly RevalidateNotifier[],
): RevalidateNotifier {
  return {
    async notify(tags: readonly string[]): Promise<void> {
      await Promise.all(notifiers.map((notifier) => notifier.notify(tags)));
    },
  };
}

export function createCacheInvalidatingNotifier(cache: ResponseCache): RevalidateNotifier {
  return {
    notify(tags: readonly string[]): Promise<void> {
      return cache.invalidateTags(tags);
    },
  };
}

export const revalidateNotifier: RevalidateNotifier = createCompositeRevalidateNotifier([
  createCacheInvalidatingNotifier(responseCache),
  createNextJsRevalidateNotifier(),
]);
