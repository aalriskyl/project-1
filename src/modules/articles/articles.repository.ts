import { and, desc, eq, isNotNull, isNull, ne, type SQL, sql } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { type ArticleRow, articles } from '@/db/schema/articles.ts';
import { users } from '@/db/schema/users.ts';
import {
  activeRecordConditions,
  buildDateRangeConditions,
  buildDescCursorCondition,
  buildStatusFilterConditions,
  isUniqueViolation,
} from '@/lib/shared/db-helpers.ts';
import { ConflictError } from '@/lib/shared/errors.ts';
import { buildFuzzySearchCondition } from '@/lib/api/search.ts';
import { withMediaMutation } from '@/modules/media/media-attachments.repository.ts';
import type {
  AdminDateListFilter,
  CursorListParams,
  OffsetListParams,
  OffsetListResult,
  SeoMetadataPatch,
  SeoMetadataRecord,
  SoftDeletableEntity,
  SoftDeletePatch,
} from '@/types/common.ts';

export interface ArticleSummaryRow extends SoftDeletableEntity, SeoMetadataRecord {
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string | null;
  readonly coverImageUrl: string | null;
  readonly tags: string[];
  readonly isPublished: boolean;
  readonly publishedAt: Date | null;
}

export interface ArticleDetailRow extends ArticleRow {
  readonly authorName: string | null;
}

export interface CreateArticleRecord extends SeoMetadataRecord {
  readonly id: string;
  readonly authorId: string;
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string | null;
  readonly contentMd: string;
  readonly coverImageUrl: string | null;
  readonly tags: string[];
  readonly relatedProductIds: string[];
  readonly isPublished: boolean;
  readonly isActive: boolean;
  readonly deletedAt?: Date | null;
  readonly publishedAt: Date | null;
}

export interface UpdateArticleRecord extends SeoMetadataPatch, SoftDeletePatch {
  readonly title?: string;
  readonly slug?: string;
  readonly excerpt?: string | null;
  readonly contentMd?: string;
  readonly coverImageUrl?: string | null;
  readonly tags?: string[];
  readonly relatedProductIds?: string[];
  readonly isPublished?: boolean;
  readonly publishedAt?: Date | null;
}

export interface AdminArticlesFilter extends AdminDateListFilter {
  readonly tag?: string;
  readonly isPublished?: boolean;
  readonly authorId?: string;
  readonly productId?: string;
}

export interface ArticlesRepository {
  listPublishedCursor(
    params: CursorListParams & {
      readonly tag?: string;
      readonly productId?: string;
      readonly query?: string;
    },
  ): Promise<readonly ArticleSummaryRow[]>;
  listAdminCursor(
    params: AdminArticlesFilter & CursorListParams,
  ): Promise<readonly ArticleSummaryRow[]>;
  listAdminOffset(
    params: AdminArticlesFilter & OffsetListParams,
  ): Promise<OffsetListResult<ArticleSummaryRow>>;
  findPublishedBySlug(slug: string): Promise<ArticleDetailRow | null>;
  findById(id: string): Promise<ArticleDetailRow | null>;
  findRelatedPublished(params: {
    readonly excludeId: string;
    readonly tags: readonly string[];
    readonly limit: number;
  }): Promise<readonly ArticleSummaryRow[]>;
  create(input: CreateArticleRecord): Promise<ArticleDetailRow>;
  updateById(id: string, patch: UpdateArticleRecord): Promise<ArticleDetailRow | null>;
  softDeleteById(id: string, deletedAt: Date): Promise<boolean>;
}

export function createArticlesRepository(db: Database): ArticlesRepository {
  const articleSearchTarget = sql`(${articles.title} || ' ' || ${articles.slug} || ' ' || coalesce(${articles.excerpt}, ''))`;

  const summaryColumns = {
    id: articles.id,
    authorId: articles.authorId,
    authorName: users.displayName,
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
    isActive: articles.isActive,
    publishedAt: articles.publishedAt,
    createdAt: articles.createdAt,
    updatedAt: articles.updatedAt,
    deletedAt: articles.deletedAt,
  };

  const detailColumns = {
    ...summaryColumns,
    contentMd: articles.contentMd,
    relatedProductIds: articles.relatedProductIds,
  };

  function buildAdminFilterConditions(params: AdminArticlesFilter): SQL[] {
    const conditions: SQL[] = [
      ...buildStatusFilterConditions(articles, params.status),
      ...buildDateRangeConditions(articles.createdAt, params),
    ];
    if (params.isPublished !== undefined) {
      conditions.push(eq(articles.isPublished, params.isPublished));
    }
    if (params.authorId !== undefined) {
      conditions.push(eq(articles.authorId, params.authorId));
    }
    if (params.tag !== undefined) {
      conditions.push(sql`${articles.tags} @> ARRAY[${params.tag}]::text[]`);
    }
    if (params.productId !== undefined) {
      conditions.push(sql`${articles.relatedProductIds} @> ARRAY[${params.productId}]::uuid[]`);
    }
    if (params.query !== undefined) {
      conditions.push(
        buildFuzzySearchCondition({
          targetSql: articleSearchTarget,
          query: params.query,
        }),
      );
    }
    return conditions;
  }

  return {
    async listPublishedCursor({
      limit,
      cursor,
      tag,
      productId,
      query,
    }): Promise<readonly ArticleSummaryRow[]> {
      const conditions: SQL[] = [
        ...activeRecordConditions(articles),
        eq(articles.isPublished, true),
      ];

      if (tag !== undefined) {
        conditions.push(sql`${articles.tags} @> ARRAY[${tag}]::text[]`);
      }

      if (productId !== undefined) {
        conditions.push(sql`${articles.relatedProductIds} @> ARRAY[${productId}]::uuid[]`);
      }

      if (query !== undefined) {
        conditions.push(
          buildFuzzySearchCondition({
            targetSql: articleSearchTarget,
            query,
          }),
        );
      }

      // Published rows must carry published_at (migration 0013 backfills and
      // constrains it); excluding NULL keeps the keyset predicate consistent.
      conditions.push(isNotNull(articles.publishedAt));
      const cursorCond = buildDescCursorCondition(articles.publishedAt, articles.id, cursor);
      if (cursorCond !== undefined) {
        conditions.push(cursorCond);
      }

      return db
        .select(summaryColumns)
        .from(articles)
        .leftJoin(users, eq(articles.authorId, users.id))
        .where(and(...conditions))
        .orderBy(desc(articles.publishedAt), desc(articles.id))
        .limit(limit);
    },

    async listAdminCursor({
      limit,
      cursor,
      tag,
      isPublished,
      authorId,
      productId,
      query,
      status,
      createdFrom,
      createdTo,
    }): Promise<readonly ArticleSummaryRow[]> {
      const conditions = buildAdminFilterConditions({
        ...(tag !== undefined ? { tag } : {}),
        ...(isPublished !== undefined ? { isPublished } : {}),
        ...(authorId !== undefined ? { authorId } : {}),
        ...(productId !== undefined ? { productId } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(createdFrom !== undefined ? { createdFrom } : {}),
        ...(createdTo !== undefined ? { createdTo } : {}),
      });

      const cursorCond = buildDescCursorCondition(articles.createdAt, articles.id, cursor);
      if (cursorCond !== undefined) {
        conditions.push(cursorCond);
      }

      return db
        .select(summaryColumns)
        .from(articles)
        .leftJoin(users, eq(articles.authorId, users.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(articles.createdAt), desc(articles.id))
        .limit(limit);
    },

    async listAdminOffset({
      limit,
      offset,
      tag,
      isPublished,
      authorId,
      productId,
      query,
      status,
      createdFrom,
      createdTo,
    }) {
      const conditions = buildAdminFilterConditions({
        ...(tag !== undefined ? { tag } : {}),
        ...(isPublished !== undefined ? { isPublished } : {}),
        ...(authorId !== undefined ? { authorId } : {}),
        ...(productId !== undefined ? { productId } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(createdFrom !== undefined ? { createdFrom } : {}),
        ...(createdTo !== undefined ? { createdTo } : {}),
      });
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [items, countRows] = await Promise.all([
        db
          .select(summaryColumns)
          .from(articles)
          .leftJoin(users, eq(articles.authorId, users.id))
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

    async findPublishedBySlug(slug: string): Promise<ArticleDetailRow | null> {
      const [row] = await db
        .select(detailColumns)
        .from(articles)
        .leftJoin(users, eq(articles.authorId, users.id))
        .where(
          and(
            eq(articles.slug, slug),
            eq(articles.isPublished, true),
            eq(articles.isActive, true),
            isNull(articles.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async findById(id: string): Promise<ArticleDetailRow | null> {
      const [row] = await db
        .select(detailColumns)
        .from(articles)
        .leftJoin(users, eq(articles.authorId, users.id))
        .where(eq(articles.id, id))
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
          .leftJoin(users, eq(articles.authorId, users.id))
          .where(
            and(
              ne(articles.id, excludeId),
              eq(articles.isPublished, true),
              eq(articles.isActive, true),
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
          .leftJoin(users, eq(articles.authorId, users.id))
          .where(
            and(
              ne(articles.id, excludeId),
              eq(articles.isPublished, true),
              eq(articles.isActive, true),
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
        .leftJoin(users, eq(articles.authorId, users.id))
        .where(
          and(
            ne(articles.id, excludeId),
            eq(articles.isPublished, true),
            eq(articles.isActive, true),
            isNull(articles.deletedAt),
          ),
        )
        .orderBy(desc(articles.publishedAt), desc(articles.id))
        .limit(limit);
    },

    async create(input: CreateArticleRecord): Promise<ArticleDetailRow> {
      try {
        return await withMediaMutation(db, 'articles', input.id, async (tx) => {
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
              isActive: input.isActive,
              deletedAt: input.deletedAt ?? null,
              publishedAt: input.publishedAt,
            })
            .returning();

          if (created === undefined) {
            throw new Error('Failed to insert article');
          }
          const [authorRow] = await tx
            .select({ displayName: users.displayName })
            .from(users)
            .where(eq(users.id, input.authorId))
            .limit(1);
          return { ...created, authorName: authorRow?.displayName ?? null };
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

    async updateById(id: string, patch: UpdateArticleRecord): Promise<ArticleDetailRow | null> {
      try {
        return await withMediaMutation(db, 'articles', id, async (tx) => {
          const [updated] = await tx
            .update(articles)
            .set({
              ...patch,
              updatedAt: new Date(),
            })
            .where(eq(articles.id, id))
            .returning();
          if (updated === undefined) {
            return null;
          }
          const authorRow =
            updated.authorId !== null
              ? (
                  await tx
                    .select({ displayName: users.displayName })
                    .from(users)
                    .where(eq(users.id, updated.authorId))
                    .limit(1)
                )[0]
              : undefined;
          return { ...updated, authorName: authorRow?.displayName ?? null };
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
      const deleted = await withMediaMutation(db, 'articles', id, async (tx) => {
        const [row] = await tx
          .update(articles)
          .set({ isActive: false, deletedAt, updatedAt: new Date() })
          .where(eq(articles.id, id))
          .returning();
        return row ?? null;
      });
      return deleted !== null;
    },
  };
}
