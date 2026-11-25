import { z } from '@hono/zod-openapi';
import { AssetImageUrlSchema, CanonicalUrlSchema } from '@/lib/asset-url.ts';
import {
  AdminPaginationQuerySchema,
  createCursorPageSchema,
  QueryBooleanSchema,
} from '@/lib/pagination.ts';
import { createSuccessEnvelopeSchema } from '@/lib/response.ts';
import { SearchQueryParamSchema } from '@/lib/search.ts';

const ArticleSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case');

const TagStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .transform((val) => val.toLowerCase());

export const RelatedProductCardSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    priceIdr: z.number().int().nonnegative(),
    requiresQuote: z.boolean(),
    primaryImageUrl: z.string().nullable(),
    stock: z.number().int().nonnegative(),
  })
  .openapi('RelatedProductCard');

export type RelatedProductCard = z.infer<typeof RelatedProductCardSchema>;

export const ArticleSummarySchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000201' }),
    authorId: z.uuid().nullable(),
    title: z
      .string()
      .openapi({ example: 'Cara Memilih Genset Silent 30 kVA untuk Kebutuhan Industri' }),
    slug: z
      .string()
      .openapi({ example: 'cara-memilih-genset-silent-30-kva-untuk-kebutuhan-industri' }),
    excerpt: z.string().nullable(),
    coverImageUrl: z.string().nullable(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    focusKeyword: z.string().nullable().openapi({ example: 'genset silent 30 kva' }),
    canonicalUrl: z.string().nullable(),
    noIndex: z.boolean(),
    ogImageUrl: z.string().nullable(),
    tags: z.array(z.string()),
    isPublished: z.boolean(),
    publishedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('ArticleSummary');

export type ArticleSummary = z.infer<typeof ArticleSummarySchema>;

export const ArticleDetailSchema = ArticleSummarySchema.extend({
  contentMd: z.string().openapi({ example: '## Panduan Kapasitas Genset\n\nPilih daya...' }),
  relatedProductIds: z.array(z.uuid()),
  relatedProducts: z.array(RelatedProductCardSchema),
  relatedArticles: z.array(ArticleSummarySchema).optional(),
}).openapi('ArticleDetail');

export type ArticleDetail = z.infer<typeof ArticleDetailSchema>;

export const ListArticlesQuerySchema = z.object({
  cursor: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .openapi({ param: { name: 'limit', in: 'query' }, example: 10 }),
  tag: TagStringSchema.optional().openapi({
    param: { name: 'tag', in: 'query' },
    description: 'Filter published articles containing this tag',
    example: 'genset',
  }),
  q: SearchQueryParamSchema,
});

export type ListArticlesQuery = z.infer<typeof ListArticlesQuerySchema>;

export const ListAdminArticlesQuerySchema = AdminPaginationQuerySchema.extend({
  tag: TagStringSchema.optional().openapi({
    param: { name: 'tag', in: 'query' },
    description: 'Filter articles containing this tag',
    example: 'genset',
  }),
  q: SearchQueryParamSchema,
});

export type ListAdminArticlesQuery = z.infer<typeof ListAdminArticlesQuerySchema>;

export const GetArticleQuerySchema = z.object({
  includeRelated: QueryBooleanSchema.optional().openapi({
    param: { name: 'includeRelated', in: 'query' },
    description: 'When true, includes up to 4 related published articles',
    example: 'true',
  }),
});

export type GetArticleQuery = z.infer<typeof GetArticleQuerySchema>;

export const ArticleSlugParamSchema = z.object({
  slug: ArticleSlugSchema.openapi({
    param: { name: 'slug', in: 'path' },
    example: 'cara-memilih-genset-silent-30-kva',
  }),
});

export const ArticleIdParamSchema = z.object({
  id: z.uuid().openapi({
    param: { name: 'id', in: 'path' },
  }),
});

const UniqueUuidArraySchema = z
  .array(z.uuid())
  .max(12)
  .transform((ids) => [...new Set(ids)]);

const UniqueTagsArraySchema = z
  .array(TagStringSchema)
  .max(20)
  .transform((tags) => [...new Set(tags)]);

export const CreateArticleBodySchema = z
  .strictObject({
    title: z.string().trim().min(3).max(255),
    slug: ArticleSlugSchema.optional(),
    excerpt: z.string().trim().max(600).nullable().optional(),
    contentMd: z.string().trim().min(1).max(200_000),
    coverImageUrl: AssetImageUrlSchema.nullable().optional(),
    metaTitle: z.string().trim().max(160).nullable().optional(),
    metaDescription: z.string().trim().max(320).nullable().optional(),
    focusKeyword: z.string().trim().max(120).nullable().optional(),
    canonicalUrl: CanonicalUrlSchema.nullable().optional(),
    noIndex: z.boolean().default(false),
    ogImageUrl: AssetImageUrlSchema.nullable().optional(),
    tags: UniqueTagsArraySchema.default([]),
    relatedProductIds: UniqueUuidArraySchema.default([]),
    isPublished: z.boolean().default(false),
  })
  .openapi('CreateArticleBody');

export type CreateArticleBody = z.infer<typeof CreateArticleBodySchema>;

export const UpdateArticleBodySchema = z
  .strictObject({
    title: z.string().trim().min(3).max(255).optional(),
    slug: ArticleSlugSchema.optional(),
    excerpt: z.string().trim().max(600).nullable().optional(),
    contentMd: z.string().trim().min(1).max(200_000).optional(),
    coverImageUrl: AssetImageUrlSchema.nullable().optional(),
    metaTitle: z.string().trim().max(160).nullable().optional(),
    metaDescription: z.string().trim().max(320).nullable().optional(),
    focusKeyword: z.string().trim().max(120).nullable().optional(),
    canonicalUrl: CanonicalUrlSchema.nullable().optional(),
    noIndex: z.boolean().optional(),
    ogImageUrl: AssetImageUrlSchema.nullable().optional(),
    tags: UniqueTagsArraySchema.optional(),
    relatedProductIds: UniqueUuidArraySchema.optional(),
    isPublished: z.boolean().optional(),
  })
  .openapi('UpdateArticleBody');

export type UpdateArticleBody = z.infer<typeof UpdateArticleBodySchema>;

export const ArticleCursorPageSchema = createCursorPageSchema(
  ArticleSummarySchema,
  'ArticleCursorPage',
);

export const ArticleDetailEnvelopeSchema = createSuccessEnvelopeSchema(
  ArticleDetailSchema,
  'ArticleDetailEnvelope',
);
