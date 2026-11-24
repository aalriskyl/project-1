import { createMiddleware } from 'hono/factory';
import { computeWeakEtag } from '@/lib/crypto.ts';
import type { AppEnv } from '@/types/app.ts';

export interface PublicCacheOptions {
  readonly maxAgeSec: number;
  readonly sMaxAgeSec?: number;
  readonly staleWhileRevalidateSec?: number;
}

function buildCacheControlDirective(options: PublicCacheOptions): string {
  const directives = [`public`, `max-age=${options.maxAgeSec}`];
  if (options.sMaxAgeSec !== undefined) {
    directives.push(`s-maxage=${options.sMaxAgeSec}`);
  }
  if (options.staleWhileRevalidateSec !== undefined) {
    directives.push(`stale-while-revalidate=${options.staleWhileRevalidateSec}`);
  }
  return directives.join(', ');
}

/**
 * Sets `Cache-Control` and weak `ETag` headers on successful GET/HEAD responses,
 * returning `304 Not Modified` when `If-None-Match` matches.
 */
export function publicCache(options: PublicCacheOptions) {
  const cacheControlValue = buildCacheControlDirective(options);

  return createMiddleware<AppEnv>(async (c, next) => {
    await next();

    const method = c.req.method;
    if ((method !== 'GET' && method !== 'HEAD') || c.res.status !== 200) {
      return;
    }

    const cloned = c.res.clone();
    const bodyText = await cloned.text();
    const etag = computeWeakEtag(bodyText);

    c.res.headers.set('Cache-Control', cacheControlValue);
    c.res.headers.set('ETag', etag);

    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
      const headers = new Headers(c.res.headers);
      headers.delete('Content-Length');
      c.res = new Response(null, {
        status: 304,
        headers,
      });
    }
  });
}
