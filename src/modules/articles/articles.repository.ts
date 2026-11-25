import { withMediaMutation } from '@/modules/media/media-attachments.repository.ts';
import { and, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { Database } from '@/db/client.ts';
import { type ArticleRow, articles } from '@/db/schema/articles.ts';
import { ConflictError } from '@/lib/errors.ts';
import type { DecodedCursor } from '@/lib/pagination.ts';
import { buildFuzzySearchCondition } from '@/lib/search.ts';

export interface ArticleSummaryRow {
  readonly id: string;
  readonly authorId: string | null;
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string | null;
  readonly coverImageUrl: string | null;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly focusKeyword: string | null;
  readonly canonicalUrl: string | null;
  readonly noIndex: boolean;
  readonly ogImageUrl: string | null;
  readonly tags: string[];
  readonly isPublished: boolean;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateArticleRecord {
  readonly id: string;
  readonly authorId: string;
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string | null;
  readonly contentMd: string;
  readonly coverImageUrl: string | null;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly focusKeyword: string | null;
  readonly canonicalUrl: string | null;
  readonly noIndex: boolean;
  readonly ogImageUrl: string | null;
  readonly tags: string[];
  readonly relatedProductIds: string[];
  readonly isPublished: boolean;
  readonly publishedAt: Date | null;
}

export interface UpdateArticleRecord {
  readonly title?: string;
  readonly slug?: string;
  readonly excerpt?: string | null;
  readonly contentMd?: string;
  readonly coverImageUrl?: string | null;
  readonly metaTitle?: string | null;
  readonly metaDescription?: string | null;
  readonly focusKeyword?: string | null;
  readonly canonicalUrl?: string | null;
  readonly noIndex?: boolean;
  readonly ogImageUrl?: string | null;
  readonly tags?: string[];
  readonly relatedProductIds?: string[];
  readonly isPublished?: boolean;
  readonly publishedAt?: Date | null;
}

export interface ArticlesRepository {
  listPublishedCursor(params: {
    readonly limit: number;
    readonly cursor?: DecodedCursor;
    readonly tag?: string;
    readonly query?: string;
  }): Promise<readonly ArticleSummaryRow[]>;
  listAdminCursor(params: {
    readonly limit: number;
    readonly cursor?: DecodedCursor;
    readonly tag?: string;
    readonly query?: string;
  }): Promise<readonly ArticleSummaryRow[]>;
  listAdminOffset(params: {
    readonly limit: number;
    readonly offset: number;
    readonly tag?: string;
    readonly query?: string;
  }): Promise<{ readonly items: readonly ArticleSummaryRow[]; readonly total: number }>;
  findPublishedBySlug(slug: string): Promise<ArticleRow | null>;
  findById(id: string): Promise<ArticleRow | null>;
  findRelatedPublished(params: {
    readonly excludeId: string;
    readonly tags: readonly string[];
    readonly limit: number;
  }): Promise<readonly ArticleSummaryRow[]>;
  create(input: CreateArticleRecord): Promise<ArticleRow>;
  updateById(id: string, patch: UpdateArticleRecord): Promise<ArticleRow | null>;
  softDeleteById(id: string, deletedAt: Date): Promise<boolean>;
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof postgres.PostgresError && err.code === '23505') {
    return true;
  }
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    return isUniqueViolation(err.cause);
  }
  return false;
}

export function createArticlesRepository(db: Database): ArticlesRepository {
  const articleSearchTarget = sql`(${articles.title} || ' ' || ${articles.slug} || ' ' || coalesce(${articles.excerpt}, ''))`;

  const summaryColumns = {
    id: articles.id,
    authorId: articles.authorId,
    title: articles.title,
    slug: articles.slug,
    excerpt: articles.excerpt,
    coverImageUrl: articles.coverImageUrl,
    metaTitle: articles.metaTitle,
    metaDescription: articles.metaDescription,
    focusKeyword: articles.focusKeyword,
    canonicalUrl: articles.canonicalUrl,
    noIndex: articles.noIndex,
    ogImageUrl: articles.ogImageUrl,
    tags: articles.tags,
    isPublished: articles.isPublished,
    publishedAt: articles.publishedAt,
    createdAt: articles.createdAt,
    updatedAt: articles.updatedAt,
  };

  return {
    async listPublishedCursor({
      limit,
      cursor,
      tag,
      query,
    }): Promise<readonly ArticleSummaryRow[]> {
      const conditions = [isNull(articles.deletedAt), eq(articles.isPublished, true)];

      if (tag !== undefined) {
        conditions.push(sql`${articles.tags} @> ARRAY[${tag}]::text[]`);
      }

      if (query !== undefined) {
        conditions.push(
          buildFuzzySearchCondition({
            targetSql: articleSearchTarget,
            query,
          }),
        );
      }

      if (cursor !== undefined) {
        const cursorCond = or(
          lt(articles.publishedAt, cursor.createdAt),
          and(eq(articles.publishedAt, cursor.createdAt), lt(articles.id, cursor.id)),
        );
        if (cursorCond !== undefined) {
          conditions.push(cursorCond);
        }
      }

      return db
        .select(summaryColumns)
        .from(articles)
        .where(and(...conditions))
        .orderBy(desc(articles.publishedAt), desc(articles.id))
        .limit(limit);
    },

    async listAdminCursor({ limit, cursor, tag, query }): Promise<readonly ArticleSummaryRow[]> {
      const conditions = [isNull(articles.deletedAt)];

      if (tag !== undefined) {
        conditions.push(sql`${articles.tags} @> ARRAY[${tag}]::text[]`);
      }

      if (query !== undefined) {
        conditions.push(
          buildFuzzySearchCondition({
            targetSql: articleSearchTarget,
            query,
          }),
        );
      }

      if (cursor !== undefined) {
        const cursorCond = or(
          lt(articles.createdAt, cursor.createdAt),
          and(eq(articles.createdAt, cursor.createdAt), lt(articles.id, cursor.id)),
        );
        if (cursorCond !== undefined) {
          conditions.push(cursorCond);
        }
      }

      return db
        .select(summaryColumns)
        .from(articles)
        .where(and(...conditions))
        .orderBy(desc(articles.createdAt), desc(articles.id))
        .limit(limit);
    },

    async listAdminOffset({ limit, offset, tag, query }) {
      const conditions = [isNull(articles.deletedAt)];

      if (tag !== undefined) {
        conditions.push(sql`${articles.tags} @> ARRAY[${tag}]::text[]`);
      }

      if (query !== undefined) {
        conditions.push(
          buildFuzzySearchCondition({
            targetSql: articleSearchTarget,
            query,
          }),
        );
      }

      const whereClause = and(...conditions);

      const [items, countRows] = await Promise.all([
        db
          .select(summaryColumns)
          .from(articles)
          .where(whereClause)
          .orderBy(desc(articles.createdAt), desc(articles.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(articles)
          .where(whereClause),
      ]);

      return { items, total: countRows[0]?.total ?? 0 };
    },

    async findPublishedBySlug(slug: string): Promise<ArticleRow | null> {
      const [row] = await db
        .select()
        .from(articles)
        .where(
          and(eq(articles.slug, slug), eq(articles.isPublished, true), isNull(articles.deletedAt)),
        )
        .limit(1);
      return row ?? null;
    },

    async findById(id: string): Promise<ArticleRow | null> {
      const [row] = await db
        .select()
        .from(articles)
        .where(and(eq(articles.id, id), isNull(articles.deletedAt)))
        .limit(1);
      return row ?? null;
    },

    async findRelatedPublished({ excludeId, tags, limit }): Promise<readonly ArticleSummaryRow[]> {
      if (tags.length > 0) {
        const tagArrayLiteral = sql.join(
          tags.map((t) => sql`${t}`),
          sql`, `,
        );
        const byTag = await db
          .select(summaryColumns)
          .from(articles)
          .where(
            and(
              ne(articles.id, excludeId),
              eq(articles.isPublished, true),
              isNull(articles.deletedAt),
              sql`${articles.tags} && ARRAY[${tagArrayLiteral}]::text[]`,
            ),
          )
          .orderBy(desc(articles.publishedAt), desc(articles.id))
          .limit(limit);

        if (byTag.length >= limit) {
          return byTag;
        }

        const seenIds = new Set([excludeId, ...byTag.map((r) => r.id)]);
        const recent = await db
          .select(summaryColumns)
          .from(articles)
          .where(
            and(
              ne(articles.id, excludeId),
              eq(articles.isPublished, true),
              isNull(articles.deletedAt),
            ),
          )
          .orderBy(desc(articles.publishedAt), desc(articles.id))
          .limit(limit + byTag.length);

        const combined = [...byTag];
        for (const item of recent) {
          if (!seenIds.has(item.id) && combined.length < limit) {
            combined.push(item);
            seenIds.add(item.id);
          }
        }
        return combined;
      }

      return db
        .select(summaryColumns)
        .from(articles)
        .where(
          and(
            ne(articles.id, excludeId),
            eq(articles.isPublished, true),
            isNull(articles.deletedAt),
          ),
        )
        .orderBy(desc(articles.publishedAt), desc(articles.id))
        .limit(limit);
    },

    async create(input: CreateArticleRecord): Promise<ArticleRow> {
      try {
        return await withMediaMutation(db, 'articles', async (tx) => {
          const [created] = await tx
            .insert(articles)
            .values({
              id: input.id,
              authorId: input.authorId,
              title: input.title,
              slug: input.slug,
              excerpt: input.excerpt,
              contentMd: input.contentMd,
              coverImageUrl: input.coverImageUrl,
              metaTitle: input.metaTitle,
              metaDescription: input.metaDescription,
              focusKeyword: input.focusKeyword,
              canonicalUrl: input.canonicalUrl,
              noIndex: input.noIndex,
              ogImageUrl: input.ogImageUrl,
              tags: input.tags,
              relatedProductIds: input.relatedProductIds,
              isPublished: input.isPublished,
              publishedAt: input.publishedAt,
            })
            .returning();

          if (created === undefined) {
            throw new Error('Failed to insert article');
          }
          return created;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            'An article with this slug already exists',
            'SLUG_ALREADY_EXISTS',
          );
        }
        throw err;
      }
    },

    async updateById(id: string, patch: UpdateArticleRecord): Promise<ArticleRow | null> {
      try {
        return await withMediaMutation(db, 'articles', async (tx) => {
          const [updated] = await tx
            .update(articles)
            .set({
              ...patch,
              updatedAt: new Date(),
            })
            .where(and(eq(articles.id, id), isNull(articles.deletedAt)))
            .returning();
          return updated ?? null;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            'An article with this slug already exists',
            'SLUG_ALREADY_EXISTS',
          );
        }
        throw err;
      }
    },

    async softDeleteById(id: string, deletedAt: Date): Promise<boolean> {
      const deleted = await withMediaMutation(db, 'articles', async (tx) => {
        const [row] = await tx
          .update(articles)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(and(eq(articles.id, id), isNull(articles.deletedAt)))
          .returning();
        return row ?? null;
      });
      return deleted !== null;
    },
  };
}
