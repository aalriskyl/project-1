import { z } from '@hono/zod-openapi';
import { AssetImageUrlSchema } from '@/lib/asset-url.ts';
import {
  AdminPaginationQuerySchema,
  createCursorPageSchema,
  QueryBooleanSchema,
} from '@/lib/pagination.ts';
import { createSuccessEnvelopeSchema } from '@/lib/response.ts';
import { SearchQueryParamSchema } from '@/lib/search.ts';
import {
  SeoMetadataCreateFields,
  SeoMetadataResponseFields,
  SeoMetadataUpdateFields,
} from '@/lib/seo.ts';
import { createSlugSchema } from '@/lib/slug.ts';
import { RecordStatusSchema, StatusFilterQueryParamSchema } from '@/lib/status.ts';

export const SpecFieldTypeSchema = z.enum(['number', 'text', 'boolean']);

export const SpecFieldDefSchema = z
  .strictObject({
    key: z
      .string()
      .regex(
        /^[a-z][a-z0-9_]{0,63}$/,
        'Spec key must start with a lowercase letter and use snake_case',
      )
      .openapi({ example: 'rated_power_kva' }),
    label: z.string().trim().min(1).max(120).openapi({ example: 'Rated Power' }),
    unit: z.string().trim().min(1).max(32).optional().openapi({ example: 'kVA' }),
    type: SpecFieldTypeSchema.openapi({ example: 'number' }),
    sortOrder: z.number().int().min(0).max(10_000).default(0).openapi({ example: 10 }),
  })
  .openapi('SpecFieldDef');

export type SpecFieldDef = z.infer<typeof SpecFieldDefSchema>;

export const SpecSchemaArraySchema = z
  .array(SpecFieldDefSchema)
  .max(50)
  .refine((items) => new Set(items.map((item) => item.key)).size === items.length, {
    message: 'specSchema keys must be unique within a category',
  });

const SlugInputSchema = createSlugSchema(140);

export const CategorySchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000101' }),
    parentId: z.uuid().nullable().openapi({ example: null }),
    name: z.string().openapi({ example: 'Genset Silent' }),
    slug: z.string().openapi({ example: 'genset-silent' }),
    description: z.string().nullable().openapi({ example: 'Industrial silent diesel generators' }),
    ...SeoMetadataResponseFields,
    metaTitle: z
      .string()
      .nullable()
      .openapi({ example: 'Jual Genset Silent 10-500 kVA | Tsuzumi' }),
    focusKeyword: z.string().nullable().openapi({ example: 'genset silent' }),
    imageUrl: z.string().nullable(),
    bannerImageUrl: z.string().nullable(),
    specSchema: z.array(SpecFieldDefSchema),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    status: RecordStatusSchema,
    deletedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Category');

export type PublicCategory = z.infer<typeof CategorySchema>;

export const CategoryTreeNodeSchema = CategorySchema.extend({
  children: z.array(CategorySchema),
}).openapi('CategoryTreeNode');

export type CategoryTreeNode = z.infer<typeof CategoryTreeNodeSchema>;

export const CategoryParentSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
  })
  .openapi('CategoryParentSummary');

export const CategoryDetailSchema = CategorySchema.extend({
  parent: CategoryParentSummarySchema.nullable(),
  subCategories: z.array(CategorySchema),
  effectiveSpecSchema: z.array(SpecFieldDefSchema),
}).openapi('CategoryDetail');

export type CategoryDetail = z.infer<typeof CategoryDetailSchema>;

export const ListCategoriesQuerySchema = z
  .object({
    tree: QueryBooleanSchema.optional().openapi({
      param: { name: 'tree', in: 'query' },
      description: 'When true, nests subcategories inside root categories under `children`',
      example: 'true',
    }),
    parentId: z
      .uuid()
      .optional()
      .openapi({
        param: { name: 'parentId', in: 'query' },
        description: 'Filter subcategories belonging to a specific parent category UUID',
      }),
    rootOnly: QueryBooleanSchema.optional().openapi({
      param: { name: 'rootOnly', in: 'query' },
      description:
        'When true returns only top-level categories; when false returns only subcategories',
    }),
    q: SearchQueryParamSchema,
  })
  .refine((q) => !(q.parentId !== undefined && q.rootOnly === true), {
    path: ['parentId'],
    message: 'Cannot combine parentId with rootOnly=true',
  })
  .refine((q) => !(q.tree === true && (q.parentId !== undefined || q.rootOnly === false)), {
    path: ['tree'],
    message: 'Cannot combine tree=true with parentId or rootOnly=false',
  });

export type ListCategoriesQuery = z.infer<typeof ListCategoriesQuerySchema>;

export const ListAdminCategoriesQuerySchema = AdminPaginationQuerySchema.extend({
  q: SearchQueryParamSchema,
  status: StatusFilterQueryParamSchema,
  parentId: z
    .uuid()
    .optional()
    .openapi({
      param: { name: 'parentId', in: 'query' },
      description: 'Filter subcategories belonging to a specific parent category UUID',
    }),
  rootOnly: QueryBooleanSchema.optional().openapi({
    param: { name: 'rootOnly', in: 'query' },
    description: 'When true returns only root categories; when false returns only subcategories',
  }),
}).refine((q) => !(q.parentId !== undefined && q.rootOnly === true), {
  path: ['parentId'],
  message: 'Cannot combine parentId with rootOnly=true',
});

export type ListAdminCategoriesQuery = z.infer<typeof ListAdminCategoriesQuerySchema>;

export const CategorySlugParamSchema = z.object({
  slug: SlugInputSchema.openapi({
    param: { name: 'slug', in: 'path' },
    example: 'genset-silent',
  }),
});

export const CategoryIdParamSchema = z.object({
  id: z.uuid().openapi({
    param: { name: 'id', in: 'path' },
  }),
});

export const CreateCategoryBodySchema = z
  .strictObject({
    parentId: z.uuid().nullable().optional(),
    name: z.string().trim().min(1).max(120).openapi({ example: 'Genset Silent' }),
    slug: SlugInputSchema.optional(),
    description: z.string().trim().max(5_000).nullable().optional(),
    ...SeoMetadataCreateFields,
    imageUrl: AssetImageUrlSchema.nullable().optional(),
    bannerImageUrl: AssetImageUrlSchema.nullable().optional(),
    specSchema: SpecSchemaArraySchema.default([]),
    sortOrder: z.number().int().min(0).max(100_000).default(0),
    isActive: z.boolean().optional(),
    status: RecordStatusSchema.optional(),
  })
  .openapi('CreateCategoryBody');

export type CreateCategoryBody = z.infer<typeof CreateCategoryBodySchema>;

export const UpdateCategoryBodySchema = z
  .strictObject({
    parentId: z.uuid().nullable().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    slug: SlugInputSchema.optional(),
    description: z.string().trim().max(5_000).nullable().optional(),
    ...SeoMetadataUpdateFields,
    imageUrl: AssetImageUrlSchema.nullable().optional(),
    bannerImageUrl: AssetImageUrlSchema.nullable().optional(),
    specSchema: SpecSchemaArraySchema.optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    isActive: z.boolean().optional(),
    status: RecordStatusSchema.optional(),
  })
  .openapi('UpdateCategoryBody');

export type UpdateCategoryBody = z.infer<typeof UpdateCategoryBodySchema>;

export const CategoryEnvelopeSchema = createSuccessEnvelopeSchema(
  CategorySchema,
  'CategoryEnvelope',
);

export const CategoryDetailEnvelopeSchema = createSuccessEnvelopeSchema(
  CategoryDetailSchema,
  'CategoryDetailEnvelope',
);

export const CategoryListEnvelopeSchema = createSuccessEnvelopeSchema(
  z.array(z.union([CategoryTreeNodeSchema, CategorySchema])),
  'CategoryListEnvelope',
);

export const CategoryCursorPageSchema = createCursorPageSchema(
  CategorySchema,
  'CategoryCursorPage',
);

export const SitemapEntrySchema = z
  .object({
    slug: z.string().openapi({ example: 'genset-silent' }),
    updatedAt: z.iso.datetime().openapi({ example: '2026-11-24T06:00:00.000Z' }),
  })
  .openapi('SitemapEntry');

export type SitemapEntry = z.infer<typeof SitemapEntrySchema>;

export const SitemapResponseSchema = createSuccessEnvelopeSchema(
  z.object({
    categories: z.array(SitemapEntrySchema),
    products: z.array(SitemapEntrySchema),
    articles: z.array(SitemapEntrySchema),
  }),
  'SitemapResponse',
);

export type SitemapData = z.infer<typeof SitemapResponseSchema>['data'];
