import { env } from '@/config/env.ts';
import { logger } from '@/lib/logger.ts';

export interface RevalidateNotifier {
  notify(tags: readonly string[]): void;
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
    notify(tags: readonly string[]): void {
      const uniqueTags = [...new Set(tags.filter((tag) => tag.length > 0))];
      if (config.url === undefined || uniqueTags.length === 0) {
        return;
      }

      const targetUrl = config.url;
      const timeoutMs = config.timeoutMs ?? REVALIDATE_TIMEOUT_MS;

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
    },
  };
}

export const revalidateNotifier: RevalidateNotifier = createNextJsRevalidateNotifier();
