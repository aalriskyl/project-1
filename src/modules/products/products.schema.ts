import { z } from '@hono/zod-openapi';
import { isAllowedAssetImageUrl, isAllowedAssetVideoUrl } from '@/lib/asset-url.ts';
import {
  AdminPaginationQuerySchema,
  CreatedFromQuerySchema,
  CreatedToQuerySchema,
  createCursorPageSchema,
  CursorPaginationQuerySchema,
  MAX_PAGE_SIZE,
  QueryBooleanSchema,
} from '@/lib/pagination.ts';
import { CategorySummaryRefSchema } from '@/lib/relations.ts';
import { createSuccessEnvelopeSchema } from '@/lib/response.ts';
import { SearchQueryParamSchema } from '@/lib/search.ts';
import {
  SeoMetadataCreateFields,
  SeoMetadataResponseFields,
  SeoMetadataUpdateFields,
} from '@/lib/seo.ts';
import { createSlugSchema } from '@/lib/slug.ts';
import { RecordStatusSchema, StatusFilterQueryParamSchema } from '@/lib/status.ts';
import { SpecFieldDefSchema } from '@/modules/catalog/catalog.schema.ts';

export const PRODUCT_TYPES = ['equipment', 'sparepart'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const ProductTypeSchema = z.enum(PRODUCT_TYPES);

const RESERVED_PRODUCT_SLUGS = new Set(['compare', 'recommendations']);

const ProductSlugSchema = createSlugSchema(280).refine(
  (slug) => !RESERVED_PRODUCT_SLUGS.has(slug),
  'This slug is reserved by the API',
);

const BrandSlugSchema = createSlugSchema(64, 'Brand slug must be lowercase kebab-case');

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
  .refine((obj) => Object.keys(obj).length <= 50, {
    message: 'specs can contain at most 50 keys',
  })
  .openapi('ProductSpecs');

export type ProductSpecs = z.infer<typeof ProductSpecsSchema>;

export const ProductCustomSpecItemSchema = z
  .strictObject({
    label: z.string().trim().min(1).max(120).openapi({ example: 'Alternator' }),
    value: z.string().trim().min(1).max(500).openapi({ example: 'Stamford UCI224D' }),
    unit: z.string().trim().min(1).max(32).optional().openapi({ example: 'dB @ 7m' }),
  })
  .openapi('ProductCustomSpecItem');

export type ProductCustomSpecItem = z.infer<typeof ProductCustomSpecItemSchema>;

export const ProductCustomSpecsSchema = z
  .array(ProductCustomSpecItemSchema)
  .max(50)
  .refine((items) => new Set(items.map((item) => item.label.toLowerCase())).size === items.length, {
    message: 'customSpecs labels must be unique per product',
  })
  .openapi('ProductCustomSpecs');

export type ProductCustomSpecs = z.infer<typeof ProductCustomSpecsSchema>;

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
    category: CategorySummaryRefSchema,
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
    isActive: z.boolean().openapi({ deprecated: true }),
    status: RecordStatusSchema,
    deletedAt: z.iso.datetime().nullable().openapi({ deprecated: true }),
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
  ...SeoMetadataResponseFields,
  media: z.array(ProductMediaItemSchema),
  specs: ProductSpecsSchema,
  customSpecs: ProductCustomSpecsSchema,
  effectiveSpecSchema: z.array(SpecFieldDefSchema),
  dimensions: ProductDimensionsSchema,
  spareparts: z.array(ProductSparepartLinkItemSchema).optional(),
  related: z.array(ProductCardSchema).optional(),
}).openapi('ProductDetail');

export type ProductDetail = z.infer<typeof ProductDetailSchema>;

export const PRODUCT_SORT_OPTIONS = ['newest', 'price_asc', 'price_desc', 'rating_desc'] as const;
export type ProductSort = (typeof PRODUCT_SORT_OPTIONS)[number];
export const ProductSortSchema = z.enum(PRODUCT_SORT_OPTIONS);

export const PRODUCT_SPEC_FILTER_OPS = ['eq', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
export type ProductSpecFilterOp = (typeof PRODUCT_SPEC_FILTER_OPS)[number];

export type ProductSpecFilter =
  | { readonly key: string; readonly op: 'gt' | 'gte' | 'lt' | 'lte'; readonly value: number }
  | { readonly key: string; readonly op: 'contains'; readonly value: string }
  | { readonly key: string; readonly op: 'eq'; readonly value: string | number | boolean };

const MAX_MULTI_BRAND_SLUGS = 10;
const MAX_SPEC_FILTERS = 10;
const SPEC_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const NUMERIC_LITERAL_RE = /^-?\d+(?:\.\d+)?$/;
const SPEC_OPS_SET = new Set<string>(PRODUCT_SPEC_FILTER_OPS);

function parseBrandSlugs(raw: string): readonly string[] | null {
  const tokens = raw.split(',').map((t) => t.trim());
  if (tokens.length === 0 || tokens.some((t) => t.length === 0)) {
    return null;
  }
  const unique: string[] = [];
  for (const token of tokens) {
    if (!BrandSlugSchema.safeParse(token).success) {
      return null;
    }
    if (!unique.includes(token)) {
      unique.push(token);
    }
  }
  if (unique.length === 0 || unique.length > MAX_MULTI_BRAND_SLUGS) {
    return null;
  }
  return unique;
}

const BrandSlugsQueryParamSchema = z
  .string()
  .trim()
  .superRefine((raw, ctx) => {
    if (parseBrandSlugs(raw) === null) {
      ctx.addIssue({
        code: 'custom',
        message: `brandSlug must be 1..${MAX_MULTI_BRAND_SLUGS} comma-separated lowercase kebab-case brand slugs`,
      });
    }
  })
  .transform((raw): readonly string[] => parseBrandSlugs(raw) ?? [])
  .optional()
  .openapi({
    param: { name: 'brandSlug', in: 'query' },
    description:
      'Filter by one or more comma-separated brand slugs (e.g. `perkins` or `perkins,cummins`)',
    example: 'perkins,cummins',
  });

function isSpecFilterOp(token: string): token is ProductSpecFilterOp {
  return SPEC_OPS_SET.has(token);
}

type ParseSpecFiltersResult =
  | { readonly ok: true; readonly filters: readonly ProductSpecFilter[] }
  | { readonly ok: false; readonly error: string };

function parseSpecFilters(raw: string): ParseSpecFiltersResult {
  const clauses = raw.split(',').map((part) => part.trim());
  if (clauses.length === 0 || clauses.some((c) => c.length === 0)) {
    return {
      ok: false,
      error: 'specs must contain non-empty comma-separated key:op:value clauses',
    };
  }
  if (clauses.length > MAX_SPEC_FILTERS) {
    return {
      ok: false,
      error: `At most ${MAX_SPEC_FILTERS} spec filter clauses are allowed per request`,
    };
  }

  const parsed: ProductSpecFilter[] = [];
  for (const clause of clauses) {
    const firstColon = clause.indexOf(':');
    if (firstColon <= 0) {
      return {
        ok: false,
        error: `Invalid spec filter "${clause}"; expected key:op:value or key:value`,
      };
    }
    const key = clause.slice(0, firstColon).trim();
    if (!SPEC_KEY_RE.test(key)) {
      return { ok: false, error: `Invalid spec key "${key}"; must be snake_case` };
    }
    const rest = clause.slice(firstColon + 1);
    const secondColon = rest.indexOf(':');
    let op: ProductSpecFilterOp;
    let rawValue: string;
    if (secondColon === -1) {
      op = 'eq';
      rawValue = rest.trim();
    } else {
      const opToken = rest.slice(0, secondColon).trim();
      if (!isSpecFilterOp(opToken)) {
        return {
          ok: false,
          error: `Unsupported spec operator "${opToken}"; use one of: ${PRODUCT_SPEC_FILTER_OPS.join(', ')}`,
        };
      }
      op = opToken;
      rawValue = rest.slice(secondColon + 1).trim();
    }

    if (rawValue.length === 0 || rawValue.length > 200) {
      return { ok: false, error: `Spec filter value for "${key}" must be 1..200 characters` };
    }

    if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (!NUMERIC_LITERAL_RE.test(rawValue)) {
        return { ok: false, error: `Spec filter "${key}:${op}" requires a numeric value` };
      }
      const numVal = Number(rawValue);
      if (!Number.isFinite(numVal)) {
        return { ok: false, error: `Spec filter "${key}:${op}" requires a finite number` };
      }
      parsed.push({ key, op, value: numVal });
    } else if (op === 'contains') {
      parsed.push({ key, op, value: rawValue });
    } else {
      const lower = rawValue.toLowerCase();
      if (lower === 'true' || lower === 'false') {
        parsed.push({ key, op: 'eq', value: lower === 'true' });
      } else if (NUMERIC_LITERAL_RE.test(rawValue) && Number.isFinite(Number(rawValue))) {
        parsed.push({ key, op: 'eq', value: Number(rawValue) });
      } else {
        parsed.push({ key, op: 'eq', value: rawValue });
      }
    }
  }

  return { ok: true, filters: parsed };
}

const ProductSpecFiltersQueryParamSchema = z
  .string()
  .trim()
  .superRefine((raw, ctx) => {
    const result = parseSpecFilters(raw);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.error });
    }
  })
  .transform((raw): readonly ProductSpecFilter[] => {
    const result = parseSpecFilters(raw);
    return result.ok ? result.filters : [];
  })
  .optional()
  .openapi({
    param: { name: 'specs', in: 'query' },
    description:
      'Dynamic JSONB spec filters as comma-separated `key:op:value` (or `key:value` for `eq`). Operators: `eq`, `gt`, `gte`, `lt`, `lte`, `contains`.',
    example: 'rated_power_kva:gte:30,silent_canopy:eq:true',
  });

export const ListProductsQuerySchema = z
  .object({
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
    sort: ProductSortSchema.default('newest').openapi({
      param: { name: 'sort', in: 'query' },
      description: 'Sort order: newest (default), price_asc, price_desc, or rating_desc',
      example: 'newest',
    }),
    categorySlug: ProductSlugSchema.optional().openapi({
      param: { name: 'categorySlug', in: 'query' },
      description:
        'Category or subcategory slug (root categories include all child subcategories; mutually exclusive with categoryId)',
    }),
    categoryId: z
      .uuid()
      .optional()
      .openapi({
        param: { name: 'categoryId', in: 'query' },
        description:
          'Category or subcategory UUID (root categories include all child subcategories; mutually exclusive with categorySlug)',
      }),
    brandSlug: BrandSlugsQueryParamSchema,
    isFeatured: QueryBooleanSchema.optional().openapi({
      param: { name: 'isFeatured', in: 'query' },
    }),
    type: ProductTypeSchema.optional().openapi({
      param: { name: 'type', in: 'query' },
    }),
    requiresQuote: QueryBooleanSchema.optional().openapi({
      param: { name: 'requiresQuote', in: 'query' },
    }),
    inStock: QueryBooleanSchema.optional().openapi({
      param: { name: 'inStock', in: 'query' },
      description:
        'When true returns products with stock > 0; when false returns out-of-stock items',
    }),
    minRating: z.coerce
      .number()
      .min(1)
      .max(5)
      .optional()
      .openapi({
        param: { name: 'minRating', in: 'query' },
        description: 'Minimum average star rating (1..5, e.g. 4 for 4 stars and up)',
        example: 4,
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
    specs: ProductSpecFiltersQueryParamSchema,
    q: SearchQueryParamSchema,
  })
  .refine((q) => !(q.categorySlug !== undefined && q.categoryId !== undefined), {
    path: ['categoryId'],
    message: 'Provide at most one of categorySlug or categoryId',
  });

export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;

export const ListProductSparepartsQuerySchema = CursorPaginationQuerySchema.extend({
  q: SearchQueryParamSchema,
});

export type ListProductSparepartsQuery = z.infer<typeof ListProductSparepartsQuerySchema>;

export const ListAdminProductsQuerySchema = AdminPaginationQuerySchema.extend({
  q: SearchQueryParamSchema,
  status: StatusFilterQueryParamSchema,
  categoryId: z
    .uuid()
    .optional()
    .openapi({
      param: { name: 'categoryId', in: 'query' },
      description: 'Filter products by category UUID',
    }),
  brandSlug: BrandSlugsQueryParamSchema,
  type: ProductTypeSchema.optional().openapi({
    param: { name: 'type', in: 'query' },
    description: 'Filter products by type (equipment or sparepart)',
  }),
  isFeatured: QueryBooleanSchema.optional().openapi({
    param: { name: 'isFeatured', in: 'query' },
    description: 'Filter products by featured flag',
  }),
  requiresQuote: QueryBooleanSchema.optional().openapi({
    param: { name: 'requiresQuote', in: 'query' },
    description: 'Filter products by RFQ-only flag',
  }),
  inStock: QueryBooleanSchema.optional().openapi({
    param: { name: 'inStock', in: 'query' },
    description: 'When true returns products with stock > 0; when false returns stock = 0',
  }),
  createdFrom: CreatedFromQuerySchema,
  createdTo: CreatedToQuerySchema,
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
    ...SeoMetadataCreateFields,
    priceIdr: z.number().int().min(0).max(100_000_000_000),
    requiresQuote: z.boolean().default(false),
    stock: z.number().int().min(0).max(1_000_000).default(0),
    isFeatured: z.boolean().default(false),
    isActive: z.boolean().optional(),
    status: RecordStatusSchema.optional(),
    media: z.array(ProductMediaItemInputSchema).max(20).default([]),
    specs: ProductSpecsSchema.default({}),
    customSpecs: ProductCustomSpecsSchema.default([]),
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
    ...SeoMetadataUpdateFields,
    priceIdr: z.number().int().min(0).max(100_000_000_000).optional(),
    requiresQuote: z.boolean().optional(),
    stock: z.number().int().min(0).max(1_000_000).optional(),
    isFeatured: z.boolean().optional(),
    isActive: z.boolean().optional(),
    status: RecordStatusSchema.optional(),
    media: z.array(ProductMediaItemInputSchema).max(20).optional(),
    specs: ProductSpecsSchema.optional(),
    customSpecs: ProductCustomSpecsSchema.optional(),
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
