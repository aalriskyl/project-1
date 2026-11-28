import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { ResponseCache } from '@/lib/cache/cache.ts';
import { CreateArticleBodySchema } from '@/modules/articles/articles.schema.ts';
import { createArticlesService } from '@/modules/articles/articles.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';
import type { AuthUser } from '@/types/app.ts';

const actor: AuthUser = {
  id: '01936c8e-7f2a-7000-8000-000000000901',
  email: 'cache@tsuzumi.test',
  role: 'admin',
};

class RecordingCache implements ResponseCache {
  readonly values = new Map<string, unknown>();

  getJson<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = this.values.get(key);
    if (raw === undefined) return Promise.resolve(null);
    const parsed = schema.safeParse(raw);
    return Promise.resolve(parsed.success ? parsed.data : null);
  }

  setJson(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  invalidateTags(): Promise<void> {
    return Promise.resolve();
  }
}

describe('article detail cache', () => {
  test('stores a resolved detail object, not a Promise', async () => {
    const store = createInMemoryDatastore();
    const cache = new RecordingCache();
    const service = createArticlesService(store.articlesRepo, { cache });
    const created = await service.createArticle(
      actor,
      CreateArticleBodySchema.parse({
        title: 'Cache regression article',
        contentMd: 'Body',
        isPublished: true,
      }),
    );

    const detail = await service.getPublishedArticleBySlug(created.slug, {});
    expect(detail.title).toBe(created.title);

    const cached = [...cache.values.values()][0];
    expect(cached).toBeDefined();
    expect(cached).not.toBeInstanceOf(Promise);
    expect(typeof cached === 'object' && cached !== null && 'title' in cached).toBe(true);

    const fromCache = await service.getPublishedArticleBySlug(created.slug, {});
    expect(fromCache.title).toBe(created.title);
  });
});
