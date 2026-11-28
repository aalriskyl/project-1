import { type ResponseCache, noopCache } from '@/lib/cache/cache.ts';
import { sanitizeMarkdown } from '@/lib/shared/markdown.ts';
import { NotFoundError } from '@/lib/shared/errors.ts';
import { generateId } from '@/lib/auth/id.ts';
import {
  buildCursorPage,
  type CursorPage,
  decodeCursor,
  encodeCursor,
  paginateAdminList,
} from '@/lib/api/pagination.ts';
import { type RevalidateNotifier, revalidateNotifier } from '@/lib/integrations/revalidate.ts';
import { slugify } from '@/lib/shared/slug.ts';
import { isRecordActive, resolveActiveStateInput, toRecordStatus } from '@/lib/api/status.ts';
import {
  type RedirectRepository,
  noopRedirectRepository,
} from '@/modules/seo/redirects.repository.ts';
import { assertAdminUser } from '@/middlewares/auth/authorize.ts';
import type {
  ArticleDetailRow,
  ArticlesRepository,
  ArticleSummaryRow,
} from '@/modules/articles/articles.repository.ts';
import { ArticleDetailSchema } from '@/modules/articles/articles.schema.ts';
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
const ARTICLE_DETAIL_CACHE_TTL_SEC = 60;

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
    author:
      row.authorId !== null && row.authorName !== null
        ? { id: row.authorId, name: row.authorName }
        : null,
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
    isActive: isRecordActive(row),
    status: toRecordStatus(row),
    deletedAt: row.deletedAt !== null ? row.deletedAt.toISOString() : null,
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
    readonly redirectsRepo?: RedirectRepository;
    readonly cache?: ResponseCache;
  } = {},
): ArticlesService {
  const revalidator = options.revalidator ?? revalidateNotifier;
  const redirectsRepo = options.redirectsRepo ?? noopRedirectRepository;
  const cache = options.cache ?? noopCache;
  const hasRelatedProductsResolver = options.resolveRelatedProducts !== undefined;
  const resolveRelatedProducts = options.resolveRelatedProducts ?? emptyRelatedProductsResolver;

  async function validateRelatedProductIds(productIds: readonly string[]): Promise<void> {
    if (!hasRelatedProductsResolver || productIds.length === 0) {
      return;
    }
    const uniqueIds = [...new Set(productIds)];
    const resolved = await resolveRelatedProducts(uniqueIds);
    if (resolved.length !== uniqueIds.length) {
      throw new NotFoundError(
        'One or more related products were not found or are inactive',
        'PRODUCT_NOT_FOUND',
      );
    }
  }

  async function serializeArticleDetail(
    row: ArticleDetailRow,
    options?: {
      readonly relatedArticles?: readonly ArticleSummaryRow[];
      readonly filterPublicRelatedIds?: boolean;
    },
  ): Promise<ArticleDetail> {
    const relatedProducts =
      row.relatedProductIds.length > 0 ? await resolveRelatedProducts(row.relatedProductIds) : [];
    const relatedProductIds =
      options?.filterPublicRelatedIds === true && hasRelatedProductsResolver
        ? relatedProducts.map((product) => product.id)
        : [...row.relatedProductIds];

    return {
      ...serializeArticleSummary(row),
      contentMd: row.contentMd,
      relatedProductIds,
      relatedProducts: [...relatedProducts],
      ...(options?.relatedArticles !== undefined
        ? { relatedArticles: options.relatedArticles.map(serializeArticleSummary) }
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
        ...(query.productId !== undefined ? { productId: query.productId } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });

      return buildCursorPage(rows, query.limit, serializeArticleSummary, (lastItem) =>
        encodeCursor({
          createdAt: lastItem.publishedAt ?? lastItem.createdAt,
          id: lastItem.id,
        }),
      );
    },

    async getPublishedArticleBySlug(slug: string, query: GetArticleQuery): Promise<ArticleDetail> {
      const cacheKey = `article:detail:${slug}:${query.includeRelated === true ? 'related' : 'plain'}`;
      const cached = await cache.getJson(cacheKey, ArticleDetailSchema);
      if (cached !== null) {
        return cached;
      }

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

      const detail = await serializeArticleDetail(article, {
        ...(relatedArticles !== undefined ? { relatedArticles } : {}),
        filterPublicRelatedIds: true,
      });
      await cache.setJson(cacheKey, detail, ARTICLE_DETAIL_CACHE_TTL_SEC, [
        `article:${slug}`,
        'products',
      ]);
      return detail;
    },

    async listAdminArticles(
      actor: AuthUser,
      query: ListAdminArticlesQuery,
    ): Promise<CursorPage<ArticleSummary>> {
      assertAdminUser(actor);

      const filters = {
        ...(query.tag !== undefined ? { tag: query.tag } : {}),
        ...(query.isPublished !== undefined ? { isPublished: query.isPublished } : {}),
        ...(query.authorId !== undefined ? { authorId: query.authorId } : {}),
        ...(query.productId !== undefined ? { productId: query.productId } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.createdFrom !== undefined ? { createdFrom: query.createdFrom } : {}),
        ...(query.createdTo !== undefined ? { createdTo: query.createdTo } : {}),
      };

      return paginateAdminList({
        query,
        listOffset: ({ limit, offset }) =>
          articlesRepo.listAdminOffset({ limit, offset, ...filters }),
        listCursor: ({ limit, cursor }) =>
          articlesRepo.listAdminCursor({
            limit,
            ...(cursor !== undefined ? { cursor } : {}),
            ...filters,
          }),
        serialize: serializeArticleSummary,
      });
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
      await validateRelatedProductIds(input.relatedProductIds);

      const resolvedActive = resolveActiveStateInput(input) ?? true;
      const resolvedSlug = input.slug ?? slugify(input.title, 260);
      const publishedAt = input.isPublished ? new Date() : null;

      const created = await articlesRepo.create({
        id: generateId(),
        authorId: actor.id,
        title: input.title,
        slug: resolvedSlug,
        excerpt: input.excerpt ?? null,
        contentMd: sanitizeMarkdown(input.contentMd),
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
        isActive: resolvedActive,
        deletedAt: resolvedActive ? null : new Date(),
        publishedAt,
      });

      await redirectsRepo.claimSlug('article', created.slug);
      if (created.isPublished && isRecordActive(created)) {
        await revalidator.notify(['articles', `article:${created.slug}`, 'sitemap']);
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

      if (input.relatedProductIds !== undefined) {
        await validateRelatedProductIds(input.relatedProductIds);
      }

      const nextActive = resolveActiveStateInput(input);
      const activePatch =
        nextActive !== undefined
          ? {
              isActive: nextActive,
              deletedAt: nextActive ? null : (existing.deletedAt ?? new Date()),
            }
          : {};

      const nextPublished = input.isPublished ?? existing.isPublished;
      const nextPublishedAt =
        nextPublished && existing.publishedAt === null ? new Date() : existing.publishedAt;

      const updated = await articlesRepo.updateById(id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
        ...(input.contentMd !== undefined ? { contentMd: sanitizeMarkdown(input.contentMd) } : {}),
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
        ...activePatch,
      });

      if (updated === null) {
        throw new NotFoundError('Article not found', 'ARTICLE_NOT_FOUND');
      }

      if (input.slug !== undefined && input.slug !== existing.slug) {
        await redirectsRepo.recordSlugChange('article', existing.slug, updated.slug);
      }
      await revalidator.notify([
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

      await articlesRepo.softDeleteById(id, existing.deletedAt ?? new Date());
      await revalidator.notify(['articles', `article:${existing.slug}`, 'sitemap']);
    },
  };
}
