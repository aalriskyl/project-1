import { z } from '@hono/zod-openapi';
import {
  AssetImageUrlSchema,
  CanonicalUrlSchema,
  isAllowedAssetImageUrl,
  isAllowedAssetVideoUrl,
} from '@/lib/asset-url.ts';
import {
  AdminPaginationQuerySchema,
  createCursorPageSchema,
  MAX_PAGE_SIZE,
  QueryBooleanSchema,
} from '@/lib/pagination.ts';
import { createSuccessEnvelopeSchema } from '@/lib/response.ts';
import { SearchQueryParamSchema } from '@/lib/search.ts';
import { SpecFieldDefSchema } from '@/modules/catalog/catalog.schema.ts';

export const PRODUCT_TYPES = ['equipment', 'sparepart'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const ProductTypeSchema = z.enum(PRODUCT_TYPES);

const ProductSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case');

const BrandSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Brand slug must be lowercase kebab-case');

export const ProductMediaTypeSchema = z.enum(['image', 'video']);

export const ProductMediaItemInputSchema = z
  .strictObject({
    id: z.uuid().optional(),
    type: ProductMediaTypeSchema.default('image'),
    url: z.url(),
    altText: z.string().trim().max(255).optional(),
  })
  .superRefine((item, ctx) => {
    if (item.type === 'image' && !isAllowedAssetImageUrl(item.url)) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Product image URL must belong to the configured public Storage bucket',
      });
    } else if (item.type === 'video' && !isAllowedAssetVideoUrl(item.url)) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message:
          'Product video URL must be a YouTube link or belong to the configured Storage bucket',
      });
    }
  })
  .openapi('ProductMediaItemInput');

export type ProductMediaItemInput = z.infer<typeof ProductMediaItemInputSchema>;

export const ProductMediaItemSchema = z
  .object({
    id: z.uuid(),
    type: ProductMediaTypeSchema,
    url: z.string(),
    altText: z.string().optional(),
  })
  .openapi('ProductMediaItem');

export type ProductMediaItem = z.infer<typeof ProductMediaItemSchema>;

export const ProductSpecPrimitiveSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
]);

export const ProductSpecsSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Spec keys must be snake_case'),
    ProductSpecPrimitiveSchema,
  )
  .openapi('ProductSpecs');

export type ProductSpecs = z.infer<typeof ProductSpecsSchema>;

export const ProductDimensionsSchema = z
  .object({
    lengthCm: z.number().nonnegative().nullable(),
    widthCm: z.number().nonnegative().nullable(),
    heightCm: z.number().nonnegative().nullable(),
    weightKg: z.number().nonnegative().nullable(),
  })
  .openapi('ProductDimensions');

export type ProductDimensions = z.infer<typeof ProductDimensionsSchema>;

export const ProductCardSchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000401' }),
    categoryId: z.uuid(),
    brandSlug: z.string().nullable().openapi({ example: 'perkins' }),
    name: z
      .string()
      .openapi({ example: 'Genset 30 kVA Silent Diesel Tsuzumi TPG30 Powered by Perkins' }),
    slug: z
      .string()
      .openapi({ example: 'genset-30-kva-silent-diesel-tsuzumi-tpg30-powered-by-perkins' }),
    sku: z.string().nullable().openapi({ example: 'TPG30-SILENT' }),
    productType: ProductTypeSchema.openapi({ example: 'equipment' }),
    priceIdr: z.number().int().nonnegative().openapi({ example: 177_500_000 }),
    requiresQuote: z.boolean().openapi({ example: true }),
    stock: z.number().int().nonnegative().openapi({ example: 2 }),
    isFeatured: z.boolean(),
    isActive: z.boolean(),
    primaryImageUrl: z.string().nullable(),
    ratingAvg: z.number().min(0).max(5).openapi({ example: 4.85 }),
    reviewCount: z.number().int().nonnegative().openapi({ example: 12 }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('ProductCard');

export type ProductCard = z.infer<typeof ProductCardSchema>;

export const ProductSparepartLinkItemSchema = ProductCardSchema.extend({
  note: z.string().nullable(),
}).openapi('ProductSparepartLinkItem');

export type ProductSparepartLinkItem = z.infer<typeof ProductSparepartLinkItemSchema>;

export const ProductDetailSchema = ProductCardSchema.extend({
  descriptionMd: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  focusKeyword: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  noIndex: z.boolean(),
  ogImageUrl: z.string().nullable(),
  media: z.array(ProductMediaItemSchema),
  specs: ProductSpecsSchema,
  effectiveSpecSchema: z.array(SpecFieldDefSchema),
  dimensions: ProductDimensionsSchema,
  spareparts: z.array(ProductSparepartLinkItemSchema).optional(),
  related: z.array(ProductCardSchema).optional(),
}).openapi('ProductDetail');

export type ProductDetail = z.infer<typeof ProductDetailSchema>;

export const ListProductsQuerySchema = z.object({
  cursor: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(20)
    .openapi({ param: { name: 'limit', in: 'query' }, example: 20 }),
  categorySlug: ProductSlugSchema.optional().openapi({
    param: { name: 'categorySlug', in: 'query' },
    description: 'Category or subcategory slug (root categories include all child subcategories)',
  }),
  brandSlug: BrandSlugSchema.optional().openapi({
    param: { name: 'brandSlug', in: 'query' },
    example: 'perkins',
  }),
  isFeatured: QueryBooleanSchema.optional().openapi({
    param: { name: 'isFeatured', in: 'query' },
  }),
  type: ProductTypeSchema.optional().openapi({
    param: { name: 'type', in: 'query' },
  }),
  requiresQuote: QueryBooleanSchema.optional().openapi({
    param: { name: 'requiresQuote', in: 'query' },
  }),
  minPrice: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .openapi({ param: { name: 'minPrice', in: 'query' } }),
  maxPrice: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .openapi({ param: { name: 'maxPrice', in: 'query' } }),
  q: SearchQueryParamSchema,
});

export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;

export const ListAdminProductsQuerySchema = AdminPaginationQuerySchema.extend({
  q: SearchQueryParamSchema,
});

export type ListAdminProductsQuery = z.infer<typeof ListAdminProductsQuerySchema>;

export type ProductDetailInclude = 'spareparts' | 'related';

export const GetProductDetailQuerySchema = z.object({
  include: z
    .string()
    .trim()
    .min(1)
    .refine(
      (raw) =>
        raw
          .split(',')
          .map((token) => token.trim())
          .every((token) => token === 'spareparts' || token === 'related'),
      { message: 'include only accepts comma-separated values: spareparts, related' },
    )
    .transform((raw): ProductDetailInclude[] => {
      const tokens = raw.split(',').map((t) => t.trim());
      const out: ProductDetailInclude[] = [];
      for (const token of tokens) {
        if ((token === 'spareparts' || token === 'related') && !out.includes(token)) {
          out.push(token);
        }
      }
      return out;
    })
    .optional()
    .openapi({
      param: { name: 'include', in: 'query' },
      example: 'spareparts,related',
    }),
});

export type GetProductDetailQuery = z.infer<typeof GetProductDetailQuerySchema>;

export const CompareProductsQuerySchema = z
  .object({
    ids: z
      .string()
      .trim()
      .optional()
      .openapi({
        param: { name: 'ids', in: 'query' },
        description: 'Comma-separated 2..4 product UUIDs',
      }),
    slugs: z
      .string()
      .trim()
      .optional()
      .openapi({
        param: { name: 'slugs', in: 'query' },
        description: 'Comma-separated 2..4 product slugs',
      }),
  })
  .refine((q) => (q.ids !== undefined) !== (q.slugs !== undefined), {
    message: 'Provide exactly one of `ids` or `slugs`',
  });

export type CompareProductsQuery = z.infer<typeof CompareProductsQuerySchema>;

export const RecommendationsQuerySchema = z.object({
  categoryId: z
    .uuid()
    .optional()
    .openapi({ param: { name: 'categoryId', in: 'query' } }),
  excludeProductId: z
    .uuid()
    .optional()
    .openapi({ param: { name: 'excludeProductId', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(12)
    .default(6)
    .openapi({ param: { name: 'limit', in: 'query' }, example: 6 }),
});

export type RecommendationsQuery = z.infer<typeof RecommendationsQuerySchema>;

export const ProductSlugParamSchema = z.object({
  slug: ProductSlugSchema.openapi({
    param: { name: 'slug', in: 'path' },
  }),
});

export const ProductIdParamSchema = z.object({
  id: z.uuid().openapi({
    param: { name: 'id', in: 'path' },
  }),
});

const DimensionFieldSchema = z.number().min(0).max(100_000).nullable().optional();

export const CreateProductBodySchema = z
  .strictObject({
    categoryId: z.uuid(),
    brandSlug: BrandSlugSchema.nullable().optional(),
    name: z.string().trim().min(2).max(255),
    slug: ProductSlugSchema.optional(),
    sku: z.string().trim().min(1).max(80).nullable().optional(),
    productType: ProductTypeSchema.default('equipment'),
    descriptionMd: z.string().trim().max(100_000).nullable().optional(),
    metaTitle: z.string().trim().max(160).nullable().optional(),
    metaDescription: z.string().trim().max(320).nullable().optional(),
    focusKeyword: z.string().trim().max(120).nullable().optional(),
    canonicalUrl: CanonicalUrlSchema.nullable().optional(),
    noIndex: z.boolean().default(false),
    ogImageUrl: AssetImageUrlSchema.nullable().optional(),
    priceIdr: z.number().int().min(0).max(100_000_000_000),
    requiresQuote: z.boolean().default(false),
    stock: z.number().int().min(0).max(1_000_000).default(0),
    isFeatured: z.boolean().default(false),
    isActive: z.boolean().default(true),
    media: z.array(ProductMediaItemInputSchema).max(20).default([]),
    specs: ProductSpecsSchema.default({}),
    lengthCm: DimensionFieldSchema,
    widthCm: DimensionFieldSchema,
    heightCm: DimensionFieldSchema,
    weightKg: DimensionFieldSchema,
  })
  .openapi('CreateProductBody');

export type CreateProductBody = z.infer<typeof CreateProductBodySchema>;

export const UpdateProductBodySchema = z
  .strictObject({
    categoryId: z.uuid().optional(),
    brandSlug: BrandSlugSchema.nullable().optional(),
    name: z.string().trim().min(2).max(255).optional(),
    slug: ProductSlugSchema.optional(),
    sku: z.string().trim().min(1).max(80).nullable().optional(),
    productType: ProductTypeSchema.optional(),
    descriptionMd: z.string().trim().max(100_000).nullable().optional(),
    metaTitle: z.string().trim().max(160).nullable().optional(),
    metaDescription: z.string().trim().max(320).nullable().optional(),
    focusKeyword: z.string().trim().max(120).nullable().optional(),
    canonicalUrl: CanonicalUrlSchema.nullable().optional(),
    noIndex: z.boolean().optional(),
    ogImageUrl: AssetImageUrlSchema.nullable().optional(),
    priceIdr: z.number().int().min(0).max(100_000_000_000).optional(),
    requiresQuote: z.boolean().optional(),
    stock: z.number().int().min(0).max(1_000_000).optional(),
    isFeatured: z.boolean().optional(),
    isActive: z.boolean().optional(),
    media: z.array(ProductMediaItemInputSchema).max(20).optional(),
    specs: ProductSpecsSchema.optional(),
    lengthCm: DimensionFieldSchema,
    widthCm: DimensionFieldSchema,
    heightCm: DimensionFieldSchema,
    weightKg: DimensionFieldSchema,
  })
  .openapi('UpdateProductBody');

export type UpdateProductBody = z.infer<typeof UpdateProductBodySchema>;

export const ReplaceSparepartsBodySchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          sparepartProductId: z.uuid(),
          note: z.string().trim().max(160).optional(),
        }),
      )
      .max(50)
      .refine((items) => new Set(items.map((i) => i.sparepartProductId)).size === items.length, {
        message: 'Duplicate sparepartProductId entries are not allowed',
      }),
  })
  .openapi('ReplaceSparepartsBody');

export type ReplaceSparepartsBody = z.infer<typeof ReplaceSparepartsBodySchema>;

export const ProductCursorPageSchema = createCursorPageSchema(
  ProductCardSchema,
  'ProductCursorPage',
);

export const SparepartCursorPageSchema = createCursorPageSchema(
  ProductSparepartLinkItemSchema,
  'SparepartCursorPage',
);

export const ProductCardListEnvelopeSchema = createSuccessEnvelopeSchema(
  z.array(ProductCardSchema),
  'ProductCardListEnvelope',
);

export const ProductSparepartsListEnvelopeSchema = createSuccessEnvelopeSchema(
  z.array(ProductSparepartLinkItemSchema),
  'ProductSparepartsListEnvelope',
);

export const ProductDetailEnvelopeSchema = createSuccessEnvelopeSchema(
  ProductDetailSchema,
  'ProductDetailEnvelope',
);

export const CompareProductsEnvelopeSchema = createSuccessEnvelopeSchema(
  z.object({
    specSchema: z.array(SpecFieldDefSchema),
    products: z.array(ProductDetailSchema),
  }),
  'CompareProductsEnvelope',
);
