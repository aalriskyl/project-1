import type { ArticleDetail } from '@/modules/articles/articles.schema.ts';
import type { ArticlesService } from '@/modules/articles/articles.service.ts';
import type { CategoryDetail } from '@/modules/catalog/catalog.schema.ts';
import type { CatalogService } from '@/modules/catalog/catalog.service.ts';
import type { ProductDetail } from '@/modules/products/products.schema.ts';
import type { ProductsService } from '@/modules/products/products.service.ts';
import { NotFoundError } from '@/lib/shared/errors.ts';
import type { RedirectRepository } from '@/modules/seo/redirects.repository.ts';
import {
  type JsonLd,
  type Redirect,
  type StructuredData,
  type StructuredDataQuery,
} from '@/modules/seo/seo.schema.ts';

export interface SeoServiceDependencies {
  readonly catalogService: CatalogService;
  readonly productsService: ProductsService;
  readonly articlesService: ArticlesService;
  readonly siteUrl: string;
  readonly siteName: string;
  readonly redirectsRepo: RedirectRepository;
}

export interface SeoService {
  getStructuredData(query: StructuredDataQuery): Promise<StructuredData>;
  getRedirect(query: StructuredDataQuery): Promise<Redirect>;
}

interface BreadcrumbItem {
  readonly name: string;
  readonly url: string;
}

function absoluteUrl(raw: string, siteUrl: string): string {
  if (URL.canParse(raw)) {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
  }
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  return new URL(raw.replace(/^\/+/, ''), base).toString();
}

function pageUrl(canonicalUrl: string | null, siteUrl: string, path: string): string {
  return absoluteUrl(canonicalUrl ?? path, siteUrl);
}

function uniqueUrls(urls: readonly (string | null | undefined)[], siteUrl: string): string[] {
  const seen = new Set<string>();
  for (const raw of urls) {
    if (raw !== null && raw !== undefined && raw.trim().length > 0) {
      seen.add(absoluteUrl(raw, siteUrl));
    }
  }
  return [...seen];
}

function plainText(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(raw: string, maxLength: number): string {
  return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength - 1).trimEnd()}…`;
}

function brandName(slug: string): string {
  return slug
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildBreadcrumb(items: readonly BreadcrumbItem[], id: string): JsonLd {
  return {
    '@type': 'BreadcrumbList',
    '@id': id,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

function buildProductGraph(product: ProductDetail, deps: SeoServiceDependencies): StructuredData {
  const url = pageUrl(product.canonicalUrl, deps.siteUrl, `/products/${product.slug}`);
  const breadcrumbId = `${url}#breadcrumb`;
  const images = uniqueUrls(
    [product.ogImageUrl, product.primaryImageUrl, ...product.media.map((item) => item.url)],
    deps.siteUrl,
  );
  const description = plainText(product.metaDescription ?? '');
  const breadcrumb: BreadcrumbItem[] = [
    { name: 'Home', url: absoluteUrl('/', deps.siteUrl) },
    {
      name: product.category.name,
      url: absoluteUrl(`/categories/${product.category.slug}`, deps.siteUrl),
    },
    { name: product.name, url },
  ];

  const productNode: JsonLd = {
    '@type': 'Product',
    '@id': `${url}#product`,
    name: product.name,
    url,
    ...(description.length > 0 ? { description } : {}),
    ...(product.sku !== null ? { sku: product.sku } : {}),
    ...(images.length > 0 ? { image: images } : {}),
    ...(product.brandSlug !== null
      ? { brand: { '@type': 'Brand', name: brandName(product.brandSlug) } }
      : {}),
    category: product.category.name,
    ...(product.requiresQuote
      ? {}
      : {
          offers: {
            '@type': 'Offer',
            priceCurrency: 'IDR',
            price: product.priceIdr,
            availability:
              product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
            url,
          },
        }),
    // Google requires a real, on-page review count before emitting AggregateRating.
    ...(product.reviewCount > 0 && product.ratingAvg > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: product.ratingAvg,
            reviewCount: product.reviewCount,
            bestRating: 5,
            worstRating: 1,
          },
        }
      : {}),
    breadcrumb: { '@id': breadcrumbId },
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [productNode, buildBreadcrumb(breadcrumb, breadcrumbId)],
  };
}

function buildCategoryGraph(
  category: CategoryDetail,
  deps: SeoServiceDependencies,
): StructuredData {
  const url = pageUrl(category.canonicalUrl, deps.siteUrl, `/categories/${category.slug}`);
  const breadcrumbId = `${url}#breadcrumb`;
  const images = uniqueUrls(
    [category.ogImageUrl, category.imageUrl, category.bannerImageUrl],
    deps.siteUrl,
  );
  const description = plainText(category.metaDescription ?? category.description ?? '');
  const breadcrumb: BreadcrumbItem[] = [
    { name: 'Home', url: absoluteUrl('/', deps.siteUrl) },
    ...(category.parent !== null
      ? [
          {
            name: category.parent.name,
            url: absoluteUrl(`/categories/${category.parent.slug}`, deps.siteUrl),
          },
        ]
      : []),
    { name: category.name, url },
  ];

  const collectionNode: JsonLd = {
    '@type': 'CollectionPage',
    '@id': url,
    name: category.metaTitle ?? category.name,
    url,
    ...(description.length > 0 ? { description } : {}),
    ...(images.length > 0 ? { image: images } : {}),
    breadcrumb: { '@id': breadcrumbId },
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [collectionNode, buildBreadcrumb(breadcrumb, breadcrumbId)],
  };
}

function buildArticleGraph(article: ArticleDetail, deps: SeoServiceDependencies): StructuredData {
  const url = pageUrl(article.canonicalUrl, deps.siteUrl, `/articles/${article.slug}`);
  const breadcrumbId = `${url}#breadcrumb`;
  const images = uniqueUrls([article.ogImageUrl, article.coverImageUrl], deps.siteUrl);
  const description = plainText(article.metaDescription ?? article.excerpt ?? '');
  const breadcrumb: BreadcrumbItem[] = [
    { name: 'Home', url: absoluteUrl('/', deps.siteUrl) },
    { name: 'Articles', url: absoluteUrl('/articles', deps.siteUrl) },
    { name: article.title, url },
  ];

  const articleNode: JsonLd = {
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: truncate(article.metaTitle ?? article.title, 110),
    url,
    datePublished: article.publishedAt ?? article.createdAt,
    dateModified: article.updatedAt,
    ...(description.length > 0 ? { description } : {}),
    ...(images.length > 0 ? { image: images } : {}),
    ...(article.author !== null
      ? { author: { '@type': 'Person', name: article.author.name } }
      : {}),
    publisher: { '@type': 'Organization', name: deps.siteName, url: deps.siteUrl },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    breadcrumb: { '@id': breadcrumbId },
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [articleNode, buildBreadcrumb(breadcrumb, breadcrumbId)],
  };
}

export function createSeoService(deps: SeoServiceDependencies): SeoService {
  return {
    async getStructuredData(query: StructuredDataQuery): Promise<StructuredData> {
      switch (query.type) {
        case 'product': {
          const product = await deps.productsService.getPublicProductBySlug(query.slug, {});
          return buildProductGraph(product, deps);
        }
        case 'category': {
          const category = await deps.catalogService.getPublicCategoryBySlug(query.slug);
          return buildCategoryGraph(category, deps);
        }
        case 'article': {
          const article = await deps.articlesService.getPublishedArticleBySlug(query.slug, {});
          return buildArticleGraph(article, deps);
        }
        default: {
          const exhaustive: never = query.type;
          return exhaustive;
        }
      }
    },

    async getRedirect(query: StructuredDataQuery): Promise<Redirect> {
      const record = await deps.redirectsRepo.findByOldSlug(query.type, query.slug);
      if (record === null) {
        throw new NotFoundError('No permanent redirect exists for this slug', 'RESOURCE_NOT_FOUND');
      }
      return { ...record, permanent: true };
    },
  };
}
