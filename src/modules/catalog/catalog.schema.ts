import { z } from '@hono/zod-openapi';
import { AssetImageUrlSchema } from '@/lib/asset-url.ts';
import { QueryBooleanSchema } from '@/lib/pagination.ts';

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

const SlugInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(140)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case');

export const CategorySchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000101' }),
    parentId: z.uuid().nullable().openapi({ example: null }),
    name: z.string().openapi({ example: 'Genset Silent' }),
    slug: z.string().openapi({ example: 'genset-silent' }),
    description: z.string().nullable().openapi({ example: 'Industrial silent diesel generators' }),
    metaTitle: z
      .string()
      .nullable()
      .openapi({ example: 'Jual Genset Silent 10-500 kVA | Tsuzumi' }),
    metaDescription: z.string().nullable(),
    imageUrl: z.string().nullable(),
    bannerImageUrl: z.string().nullable(),
    specSchema: z.array(SpecFieldDefSchema),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
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

export const ListCategoriesQuerySchema = z.object({
  tree: QueryBooleanSchema.optional().openapi({
    param: { name: 'tree', in: 'query' },
    description: 'When true, nests subcategories inside root categories under `children`',
    example: 'true',
  }),
});

export type ListCategoriesQuery = z.infer<typeof ListCategoriesQuerySchema>;

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
    metaTitle: z.string().trim().max(160).nullable().optional(),
    metaDescription: z.string().trim().max(320).nullable().optional(),
    imageUrl: AssetImageUrlSchema.nullable().optional(),
    bannerImageUrl: AssetImageUrlSchema.nullable().optional(),
    specSchema: SpecSchemaArraySchema.default([]),
    sortOrder: z.number().int().min(0).max(100_000).default(0),
    isActive: z.boolean().default(true),
  })
  .openapi('CreateCategoryBody');

export type CreateCategoryBody = z.infer<typeof CreateCategoryBodySchema>;

export const UpdateCategoryBodySchema = z
  .strictObject({
    parentId: z.uuid().nullable().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    slug: SlugInputSchema.optional(),
    description: z.string().trim().max(5_000).nullable().optional(),
    metaTitle: z.string().trim().max(160).nullable().optional(),
    metaDescription: z.string().trim().max(320).nullable().optional(),
    imageUrl: AssetImageUrlSchema.nullable().optional(),
    bannerImageUrl: AssetImageUrlSchema.nullable().optional(),
    specSchema: SpecSchemaArraySchema.optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    isActive: z.boolean().optional(),
  })
  .openapi('UpdateCategoryBody');

export type UpdateCategoryBody = z.infer<typeof UpdateCategoryBodySchema>;

export const CategoryEnvelopeSchema = z
  .object({ data: CategorySchema })
  .openapi('CategoryEnvelope');

export const CategoryDetailEnvelopeSchema = z
  .object({ data: CategoryDetailSchema })
  .openapi('CategoryDetailEnvelope');

export const CategoryListEnvelopeSchema = z
  .object({
    data: z.array(z.union([CategoryTreeNodeSchema, CategorySchema])),
  })
  .openapi('CategoryListEnvelope');

export const SitemapEntrySchema = z
  .object({
    slug: z.string().openapi({ example: 'genset-silent' }),
    updatedAt: z.iso.datetime().openapi({ example: '2026-11-24T06:00:00.000Z' }),
  })
  .openapi('SitemapEntry');

export type SitemapEntry = z.infer<typeof SitemapEntrySchema>;

export const SitemapResponseSchema = z
  .object({
    data: z.object({
      categories: z.array(SitemapEntrySchema),
      products: z.array(SitemapEntrySchema),
      articles: z.array(SitemapEntrySchema),
    }),
  })
  .openapi('SitemapResponse');

export type SitemapData = z.infer<typeof SitemapResponseSchema>['data'];
