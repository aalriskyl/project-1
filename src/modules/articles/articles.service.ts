import type { ArticleRow } from '@/db/schema/articles.ts';
import { NotFoundError } from '@/lib/errors.ts';
import { generateId } from '@/lib/id.ts';
import {
  assertCursorOrPage,
  buildOffsetPage,
  type CursorPage,
  decodeCursor,
  encodeCursor,
} from '@/lib/pagination.ts';
import { type RevalidateNotifier, revalidateNotifier } from '@/lib/revalidate.ts';
import { slugify } from '@/lib/slug.ts';
import { assertAdminUser } from '@/middlewares/authorize.ts';
import type {
  ArticlesRepository,
  ArticleSummaryRow,
} from '@/modules/articles/articles.repository.ts';
import type {
  ArticleDetail,
  ArticleSummary,
  CreateArticleBody,
  GetArticleQuery,
  ListAdminArticlesQuery,
  ListArticlesQuery,
  RelatedProductCard,
  UpdateArticleBody,
} from '@/modules/articles/articles.schema.ts';
import type { AuthUser } from '@/types/app.ts';

const RELATED_ARTICLES_LIMIT = 4;

export type RelatedProductsResolver = (
  productIds: readonly string[],
) => Promise<readonly RelatedProductCard[]>;

const emptyRelatedProductsResolver: RelatedProductsResolver = () => Promise.resolve([]);

export interface ArticlesService {
  listPublishedArticles(query: ListArticlesQuery): Promise<CursorPage<ArticleSummary>>;
  getPublishedArticleBySlug(slug: string, query: GetArticleQuery): Promise<ArticleDetail>;
  listAdminArticles(
    actor: AuthUser,
    query: ListAdminArticlesQuery,
  ): Promise<CursorPage<ArticleSummary>>;
  getAdminArticleById(actor: AuthUser, id: string): Promise<ArticleDetail>;
  createArticle(actor: AuthUser, input: CreateArticleBody): Promise<ArticleDetail>;
  updateArticle(actor: AuthUser, id: string, input: UpdateArticleBody): Promise<ArticleDetail>;
  deleteArticle(actor: AuthUser, id: string): Promise<void>;
}

export function serializeArticleSummary(row: ArticleSummaryRow): ArticleSummary {
  return {
    id: row.id,
    authorId: row.authorId,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    coverImageUrl: row.coverImageUrl,
    metaTitle: row.metaTitle,
    metaDescription: row.metaDescription,
    focusKeyword: row.focusKeyword,
    canonicalUrl: row.canonicalUrl,
    noIndex: row.noIndex,
    ogImageUrl: row.ogImageUrl,
    tags: [...row.tags],
    isPublished: row.isPublished,
    publishedAt: row.publishedAt !== null ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createArticlesService(
  articlesRepo: ArticlesRepository,
  options: {
    readonly revalidator?: RevalidateNotifier;
    readonly resolveRelatedProducts?: RelatedProductsResolver;
  } = {},
): ArticlesService {
  const revalidator = options.revalidator ?? revalidateNotifier;
  const resolveRelatedProducts = options.resolveRelatedProducts ?? emptyRelatedProductsResolver;

  async function serializeArticleDetail(
    row: ArticleRow,
    relatedArticles?: readonly ArticleSummaryRow[],
  ): Promise<ArticleDetail> {
    const relatedProducts =
      row.relatedProductIds.length > 0 ? await resolveRelatedProducts(row.relatedProductIds) : [];

    return {
      ...serializeArticleSummary(row),
      contentMd: row.contentMd,
      relatedProductIds: [...row.relatedProductIds],
      relatedProducts: [...relatedProducts],
      ...(relatedArticles !== undefined
        ? { relatedArticles: relatedArticles.map(serializeArticleSummary) }
        : {}),
    };
  }

  return {
    async listPublishedArticles(query: ListArticlesQuery): Promise<CursorPage<ArticleSummary>> {
      const decodedCursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;
      const rows = await articlesRepo.listPublishedCursor({
        limit: query.limit + 1,
        ...(decodedCursor !== undefined ? { cursor: decodedCursor } : {}),
        ...(query.tag !== undefined ? { tag: query.tag } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });

      const hasMore = rows.length > query.limit;
      const pageItems = hasMore ? rows.slice(0, query.limit) : rows;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor =
        hasMore && lastItem !== undefined
          ? encodeCursor({
              createdAt: lastItem.publishedAt ?? lastItem.createdAt,
              id: lastItem.id,
            })
          : null;

      return {
        data: pageItems.map(serializeArticleSummary),
        meta: {
          nextCursor,
          hasMore,
          limit: query.limit,
        },
      };
    },

    async getPublishedArticleBySlug(slug: string, query: GetArticleQuery): Promise<ArticleDetail> {
      const article = await articlesRepo.findPublishedBySlug(slug);
      if (article === null) {
        throw new NotFoundError('Article not found', 'ARTICLE_NOT_FOUND');
      }

      const relatedArticles =
        query.includeRelated === true
          ? await articlesRepo.findRelatedPublished({
              excludeId: article.id,
              tags: article.tags,
              limit: RELATED_ARTICLES_LIMIT,
            })
          : undefined;

      return serializeArticleDetail(article, relatedArticles);
    },

    async listAdminArticles(
      actor: AuthUser,
      query: ListAdminArticlesQuery,
    ): Promise<CursorPage<ArticleSummary>> {
      assertAdminUser(actor);
      assertCursorOrPage(query);

      if (query.page !== undefined) {
        const offset = (query.page - 1) * query.limit;
        const { items, total } = await articlesRepo.listAdminOffset({
          limit: query.limit,
          offset,
          ...(query.tag !== undefined ? { tag: query.tag } : {}),
          ...(query.q !== undefined ? { query: query.q } : {}),
        });
        return buildOffsetPage(items.map(serializeArticleSummary), total, query.page, query.limit);
      }

      const decodedCursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;
      const rows = await articlesRepo.listAdminCursor({
        limit: query.limit + 1,
        ...(decodedCursor !== undefined ? { cursor: decodedCursor } : {}),
        ...(query.tag !== undefined ? { tag: query.tag } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });

      const hasMore = rows.length > query.limit;
      const pageItems = hasMore ? rows.slice(0, query.limit) : rows;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor =
        hasMore && lastItem !== undefined
          ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
          : null;

      return {
        data: pageItems.map(serializeArticleSummary),
        meta: {
          nextCursor,
          hasMore,
          limit: query.limit,
        },
      };
    },

    async getAdminArticleById(actor: AuthUser, id: string): Promise<ArticleDetail> {
      assertAdminUser(actor);

      const article = await articlesRepo.findById(id);
      if (article === null) {
        throw new NotFoundError('Article not found', 'ARTICLE_NOT_FOUND');
      }
      return serializeArticleDetail(article);
    },

    async createArticle(actor: AuthUser, input: CreateArticleBody): Promise<ArticleDetail> {
      assertAdminUser(actor);

      const resolvedSlug = input.slug ?? slugify(input.title, 260);
      const publishedAt = input.isPublished ? new Date() : null;

      const created = await articlesRepo.create({
        id: generateId(),
        authorId: actor.id,
        title: input.title,
        slug: resolvedSlug,
        excerpt: input.excerpt ?? null,
        contentMd: input.contentMd,
        coverImageUrl: input.coverImageUrl ?? null,
        metaTitle: input.metaTitle ?? null,
        metaDescription: input.metaDescription ?? null,
        focusKeyword: input.focusKeyword ?? null,
        canonicalUrl: input.canonicalUrl ?? null,
        noIndex: input.noIndex,
        ogImageUrl: input.ogImageUrl ?? null,
        tags: input.tags,
        relatedProductIds: input.relatedProductIds,
        isPublished: input.isPublished,
        publishedAt,
      });

      if (created.isPublished) {
        revalidator.notify(['articles', `article:${created.slug}`, 'sitemap']);
      }

      return serializeArticleDetail(created);
    },

    async updateArticle(
      actor: AuthUser,
      id: string,
      input: UpdateArticleBody,
    ): Promise<ArticleDetail> {
      assertAdminUser(actor);

      const existing = await articlesRepo.findById(id);
      if (existing === null) {
        throw new NotFoundError('Article not found', 'ARTICLE_NOT_FOUND');
      }

      const nextPublished = input.isPublished ?? existing.isPublished;
      const nextPublishedAt =
        nextPublished && existing.publishedAt === null ? new Date() : existing.publishedAt;

      const updated = await articlesRepo.updateById(id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
        ...(input.contentMd !== undefined ? { contentMd: input.contentMd } : {}),
        ...(input.coverImageUrl !== undefined ? { coverImageUrl: input.coverImageUrl } : {}),
        ...(input.metaTitle !== undefined ? { metaTitle: input.metaTitle } : {}),
        ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
        ...(input.focusKeyword !== undefined ? { focusKeyword: input.focusKeyword } : {}),
        ...(input.canonicalUrl !== undefined ? { canonicalUrl: input.canonicalUrl } : {}),
        ...(input.noIndex !== undefined ? { noIndex: input.noIndex } : {}),
        ...(input.ogImageUrl !== undefined ? { ogImageUrl: input.ogImageUrl } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.relatedProductIds !== undefined
          ? { relatedProductIds: input.relatedProductIds }
          : {}),
        ...(input.isPublished !== undefined
          ? { isPublished: input.isPublished, publishedAt: nextPublishedAt }
          : {}),
      });

      if (updated === null) {
        throw new NotFoundError('Article not found', 'ARTICLE_NOT_FOUND');
      }

      revalidator.notify([
        'articles',
        `article:${existing.slug}`,
        `article:${updated.slug}`,
        'sitemap',
      ]);

      return serializeArticleDetail(updated);
    },

    async deleteArticle(actor: AuthUser, id: string): Promise<void> {
      assertAdminUser(actor);

      const existing = await articlesRepo.findById(id);
      if (existing === null) {
        throw new NotFoundError('Article not found', 'ARTICLE_NOT_FOUND');
      }

      await articlesRepo.softDeleteById(id, new Date());
      revalidator.notify(['articles', `article:${existing.slug}`, 'sitemap']);
    },
  };
}
