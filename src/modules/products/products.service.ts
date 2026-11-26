import { z } from 'zod';
import type { CategoryRow } from '@/db/schema/categories.ts';
import type {
  ProductCustomSpecRow,
  ProductMediaItemRow,
  ProductRow,
  ProductSpecsMap,
} from '@/db/schema/products.ts';
import { NotFoundError, ValidationError, type ValidationIssueDetail } from '@/lib/errors.ts';
import { generateId } from '@/lib/id.ts';
import {
  buildCursorPage,
  type CursorPage,
  decodeCursor,
  encodeCursor,
  paginateAdminList,
} from '@/lib/pagination.ts';
import { type RevalidateNotifier, revalidateNotifier } from '@/lib/revalidate.ts';
import { slugify } from '@/lib/slug.ts';
import { isRecordActive, resolveActiveStateInput, toRecordStatus } from '@/lib/status.ts';
import { assertAdminUser } from '@/middlewares/authorize.ts';
import type { RelatedProductCard } from '@/modules/articles/articles.schema.ts';
import type { CatalogRepository } from '@/modules/catalog/catalog.repository.ts';
import type { SpecFieldDef } from '@/modules/catalog/catalog.schema.ts';
import { mergeEffectiveSpecSchema } from '@/modules/catalog/catalog.service.ts';
import type {
  ProductCardRow,
  ProductSortCursor,
  ProductSparepartCardRow,
  ProductsRepository,
} from '@/modules/products/products.repository.ts';
import type {
  CompareProductsQuery,
  CreateProductBody,
  GetProductDetailQuery,
  ListAdminProductsQuery,
  ListProductSparepartsQuery,
  ListProductsQuery,
  ProductCard,
  ProductCustomSpecItem,
  ProductDetail,
  ProductMediaItemInput,
  ProductSort,
  ProductSparepartLinkItem,
  ProductType,
  RecommendationsQuery,
  ReplaceSparepartsBody,
  UpdateProductBody,
} from '@/modules/products/products.schema.ts';
import type { AuthUser } from '@/types/app.ts';

const COMPARE_MIN_ITEMS = 2;
const COMPARE_MAX_ITEMS = 4;
const DEFAULT_RELATED_LIMIT = 6;

const UuidValidator = z.uuid();
const SlugValidator = z
  .string()
  .min(1)
  .max(280)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const ProductSortCursorPayloadSchema = z.discriminatedUnion('sort', [
  z.object({
    sort: z.literal('price_asc'),
    priceIdr: z.number().int().nonnegative(),
    id: z.uuid(),
  }),
  z.object({
    sort: z.literal('price_desc'),
    priceIdr: z.number().int().nonnegative(),
    id: z.uuid(),
  }),
  z.object({
    sort: z.literal('rating_desc'),
    ratingAvg: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    reviewCount: z.number().int().nonnegative(),
    id: z.uuid(),
  }),
]);

function encodeProductSortCursor(sort: ProductSort, row: ProductCardRow): string {
  if (sort === 'newest') {
    return encodeCursor(row);
  }
  const payload =
    sort === 'rating_desc'
      ? { sort, ratingAvg: row.ratingAvg, reviewCount: row.reviewCount, id: row.id }
      : { sort, priceIdr: row.priceIdr, id: row.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeProductSortCursor(rawCursor: string, sort: ProductSort): ProductSortCursor {
  if (sort === 'newest') {
    const decoded = decodeCursor(rawCursor);
    return { sort: 'newest', createdAt: decoded.createdAt, id: decoded.id };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('Invalid pagination cursor', [
      { field: 'cursor', message: 'Malformed pagination cursor' },
    ]);
  }

  const validated = ProductSortCursorPayloadSchema.safeParse(parsedJson);
  if (!validated.success || validated.data.sort !== sort) {
    throw new ValidationError('Invalid pagination cursor for requested sort order', [
      { field: 'cursor', message: `Cursor does not match sort="${sort}"` },
    ]);
  }

  return validated.data;
}

export interface ProductsService {
  listPublicProducts(query: ListProductsQuery): Promise<CursorPage<ProductCard>>;
  getPublicProductBySlug(slug: string, query: GetProductDetailQuery): Promise<ProductDetail>;
  compareProducts(query: CompareProductsQuery): Promise<{
    readonly specSchema: readonly SpecFieldDef[];
    readonly products: readonly ProductDetail[];
  }>;
  listRecommendations(query: RecommendationsQuery): Promise<readonly ProductCard[]>;
  listProductSpareparts(
    productId: string,
    query: ListProductSparepartsQuery,
  ): Promise<CursorPage<ProductSparepartLinkItem>>;
  resolveRelatedProductCards(productIds: readonly string[]): Promise<readonly RelatedProductCard[]>;
  listAdminProducts(
    actor: AuthUser,
    query: ListAdminProductsQuery,
  ): Promise<CursorPage<ProductCard>>;
  getAdminProductById(actor: AuthUser, id: string): Promise<ProductDetail>;
  createProduct(actor: AuthUser, input: CreateProductBody): Promise<ProductDetail>;
  updateProduct(actor: AuthUser, id: string, input: UpdateProductBody): Promise<ProductDetail>;
  deleteProduct(actor: AuthUser, id: string): Promise<void>;
  replaceProductSpareparts(
    actor: AuthUser,
    productId: string,
    body: ReplaceSparepartsBody,
  ): Promise<readonly ProductSparepartLinkItem[]>;
}

function normalizeProductType(raw: string): ProductType {
  return raw === 'sparepart' ? 'sparepart' : 'equipment';
}

function parseNumericNullable(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumericInput(value: number | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.toFixed(2);
}

export function serializeProductCard(row: ProductCardRow): ProductCard {
  return {
    id: row.id,
    categoryId: row.categoryId,
    brandSlug: row.brandSlug,
    name: row.name,
    slug: row.slug,
    sku: row.sku,
    productType: normalizeProductType(row.productType),
    priceIdr: row.priceIdr,
    requiresQuote: row.requiresQuote,
    stock: row.stock,
    isFeatured: row.isFeatured,
    isActive: isRecordActive(row),
    status: toRecordStatus(row),
    deletedAt: row.deletedAt !== null ? row.deletedAt.toISOString() : null,
    primaryImageUrl: row.primaryImageUrl,
    ratingAvg: Number(row.ratingAvg),
    reviewCount: row.reviewCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeSparepartItem(row: ProductSparepartCardRow): ProductSparepartLinkItem {
  return {
    ...serializeProductCard(row),
    note: row.note,
  };
}

function normalizeMediaItems(items: readonly ProductMediaItemInput[]): {
  readonly media: ProductMediaItemRow[];
  readonly primaryImageUrl: string | null;
} {
  const normalized: ProductMediaItemRow[] = items.map((item) => ({
    id: item.id ?? generateId(),
    type: item.type,
    url: item.url,
    ...(item.altText !== undefined && item.altText.length > 0 ? { altText: item.altText } : {}),
  }));

  const firstImage = normalized.find((m) => m.type === 'image');
  return {
    media: normalized,
    primaryImageUrl: firstImage?.url ?? null,
  };
}

function normalizeCustomSpecs(items: readonly ProductCustomSpecItem[]): ProductCustomSpecRow[] {
  return items.map((item) => ({
    label: item.label,
    value: item.value,
    ...(item.unit !== undefined && item.unit.length > 0 ? { unit: item.unit } : {}),
  }));
}

function validateSpecsAgainstSchema(
  specs: ProductSpecsMap,
  effectiveSchema: readonly SpecFieldDef[],
): void {
  const entries = Object.entries(specs);
  if (entries.length === 0) {
    return;
  }

  const schemaByKey = new Map(effectiveSchema.map((field) => [field.key, field]));
  const issues: ValidationIssueDetail[] = [];

  for (const [key, value] of entries) {
    const def = schemaByKey.get(key);
    if (def === undefined) {
      if (effectiveSchema.length > 0) {
        issues.push({
          field: `specs.${key}`,
          message: `Unknown specification key "${key}" for the selected category`,
        });
      }
      continue;
    }

    if (def.type === 'number' && typeof value !== 'number') {
      issues.push({
        field: `specs.${key}`,
        message: `"${def.label}" must be a number`,
      });
    } else if (def.type === 'boolean' && typeof value !== 'boolean') {
      issues.push({
        field: `specs.${key}`,
        message: `"${def.label}" must be a boolean`,
      });
    } else if (def.type === 'text' && typeof value !== 'string') {
      issues.push({
        field: `specs.${key}`,
        message: `"${def.label}" must be a string`,
      });
    }
  }

  if (issues.length > 0) {
    throw new ValidationError('Product specs failed category schema validation', issues);
  }
}

export function createProductsService(
  productsRepo: ProductsRepository,
  catalogRepo: CatalogRepository,
  revalidator: RevalidateNotifier = revalidateNotifier,
): ProductsService {
  async function resolveCategoryWithSchema(categoryId: string): Promise<{
    readonly category: CategoryRow;
    readonly effectiveSpecSchema: SpecFieldDef[];
  }> {
    const category = await catalogRepo.findById(categoryId);
    if (category === null) {
      throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
    }

    const parent =
      category.parentId !== null ? await catalogRepo.findById(category.parentId) : null;

    return {
      category,
      effectiveSpecSchema: mergeEffectiveSpecSchema(parent?.specSchema ?? [], category.specSchema),
    };
  }

  function serializeProductDetail(
    row: ProductRow,
    effectiveSpecSchema: readonly SpecFieldDef[],
    extras?: {
      readonly spareparts?: readonly ProductSparepartLinkItem[];
      readonly related?: readonly ProductCard[];
    },
  ): ProductDetail {
    return {
      ...serializeProductCard(row),
      descriptionMd: row.descriptionMd,
      metaTitle: row.metaTitle,
      metaDescription: row.metaDescription,
      focusKeyword: row.focusKeyword,
      canonicalUrl: row.canonicalUrl,
      noIndex: row.noIndex,
      ogImageUrl: row.ogImageUrl,
      media: row.media.map((m) => ({
        id: m.id,
        type: m.type,
        url: m.url,
        ...(m.altText !== undefined ? { altText: m.altText } : {}),
      })),
      specs: { ...row.specs },
      customSpecs: row.customSpecs.map((item) => ({
        label: item.label,
        value: item.value,
        ...(item.unit !== undefined ? { unit: item.unit } : {}),
      })),
      effectiveSpecSchema: [...effectiveSpecSchema],
      dimensions: {
        lengthCm: parseNumericNullable(row.lengthCm),
        widthCm: parseNumericNullable(row.widthCm),
        heightCm: parseNumericNullable(row.heightCm),
        weightKg: parseNumericNullable(row.weightKg),
      },
      ...(extras?.spareparts !== undefined ? { spareparts: [...extras.spareparts] } : {}),
      ...(extras?.related !== undefined ? { related: [...extras.related] } : {}),
    };
  }

  return {
    async listPublicProducts(query: ListProductsQuery): Promise<CursorPage<ProductCard>> {
      if (
        query.minPrice !== undefined &&
        query.maxPrice !== undefined &&
        query.minPrice > query.maxPrice
      ) {
        throw new ValidationError('Invalid price range', [
          { field: 'minPrice', message: 'minPrice must be less than or equal to maxPrice' },
        ]);
      }

      let categoryIds: string[] | undefined;
      if (query.categorySlug !== undefined) {
        const matchedCat = await catalogRepo.findActiveBySlug(query.categorySlug);
        if (matchedCat === null) {
          return { data: [], meta: { nextCursor: null, hasMore: false, limit: query.limit } };
        }
        if (matchedCat.parentId === null) {
          const children = await catalogRepo.listActiveChildren(matchedCat.id);
          categoryIds = [matchedCat.id, ...children.map((c) => c.id)];
        } else {
          categoryIds = [matchedCat.id];
        }
      } else if (query.categoryId !== undefined) {
        const matchedCat = await catalogRepo.findById(query.categoryId);
        if (matchedCat === null || !isRecordActive(matchedCat)) {
          return { data: [], meta: { nextCursor: null, hasMore: false, limit: query.limit } };
        }
        if (matchedCat.parentId === null) {
          const children = await catalogRepo.listActiveChildren(matchedCat.id);
          categoryIds = [matchedCat.id, ...children.map((c) => c.id)];
        } else {
          categoryIds = [matchedCat.id];
        }
      }

      const sort = query.sort;
      const decodedCursor =
        query.cursor !== undefined ? decodeProductSortCursor(query.cursor, sort) : undefined;
      const rows = await productsRepo.listPublicCursor({
        limit: query.limit + 1,
        sort,
        ...(decodedCursor !== undefined ? { cursor: decodedCursor } : {}),
        ...(categoryIds !== undefined ? { categoryIds } : {}),
        ...(query.brandSlug !== undefined ? { brandSlugs: query.brandSlug } : {}),
        ...(query.isFeatured !== undefined ? { isFeatured: query.isFeatured } : {}),
        ...(query.type !== undefined ? { productType: query.type } : {}),
        ...(query.requiresQuote !== undefined ? { requiresQuote: query.requiresQuote } : {}),
        ...(query.inStock !== undefined ? { inStock: query.inStock } : {}),
        ...(query.minRating !== undefined ? { minRating: query.minRating } : {}),
        ...(query.minPrice !== undefined ? { minPrice: query.minPrice } : {}),
        ...(query.maxPrice !== undefined ? { maxPrice: query.maxPrice } : {}),
        ...(query.specs !== undefined ? { specFilters: query.specs } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });

      return buildCursorPage(rows, query.limit, serializeProductCard, (lastItem) =>
        encodeProductSortCursor(sort, lastItem),
      );
    },

    async getPublicProductBySlug(
      slug: string,
      query: GetProductDetailQuery,
    ): Promise<ProductDetail> {
      const product = await productsRepo.findActiveBySlug(slug);
      if (product === null) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      const includeSet = new Set(query.include ?? []);
      const [schemaInfo, sparepartRows, relatedRows] = await Promise.all([
        resolveCategoryWithSchema(product.categoryId),
        includeSet.has('spareparts')
          ? productsRepo.listSparepartsCursor({ parentProductId: product.id, limit: 24 })
          : Promise.resolve(undefined),
        includeSet.has('related')
          ? productsRepo.listRecommendations({
              categoryId: product.categoryId,
              excludeProductId: product.id,
              limit: DEFAULT_RELATED_LIMIT,
            })
          : Promise.resolve(undefined),
      ]);

      return serializeProductDetail(product, schemaInfo.effectiveSpecSchema, {
        ...(sparepartRows !== undefined
          ? { spareparts: sparepartRows.map(serializeSparepartItem) }
          : {}),
        ...(relatedRows !== undefined ? { related: relatedRows.map(serializeProductCard) } : {}),
      });
    },

    async compareProducts(query: CompareProductsQuery) {
      let orderedRows: ProductRow[];

      if (query.ids !== undefined) {
        const rawIds = [
          ...new Set(
            query.ids
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          ),
        ];
        if (rawIds.length < COMPARE_MIN_ITEMS || rawIds.length > COMPARE_MAX_ITEMS) {
          throw new ValidationError(
            `Compare requires between ${COMPARE_MIN_ITEMS} and ${COMPARE_MAX_ITEMS} unique products`,
            [{ field: 'ids', message: 'Must specify 2 to 4 unique UUIDs' }],
          );
        }
        for (const id of rawIds) {
          if (!UuidValidator.safeParse(id).success) {
            throw new ValidationError('Invalid UUID in compare ids', [
              { field: 'ids', message: `Invalid UUID "${id}"` },
            ]);
          }
        }
        const fetched = await productsRepo.findActiveByIds(rawIds);
        const byId = new Map(fetched.map((r) => [r.id, r]));
        orderedRows = rawIds.flatMap((id) => {
          const found = byId.get(id);
          return found !== undefined ? [found] : [];
        });
      } else {
        const rawSlugs = [
          ...new Set(
            (query.slugs ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          ),
        ];
        if (rawSlugs.length < COMPARE_MIN_ITEMS || rawSlugs.length > COMPARE_MAX_ITEMS) {
          throw new ValidationError(
            `Compare requires between ${COMPARE_MIN_ITEMS} and ${COMPARE_MAX_ITEMS} unique products`,
            [{ field: 'slugs', message: 'Must specify 2 to 4 unique slugs' }],
          );
        }
        for (const slug of rawSlugs) {
          if (!SlugValidator.safeParse(slug).success) {
            throw new ValidationError('Invalid slug in compare slugs', [
              { field: 'slugs', message: `Invalid slug "${slug}"` },
            ]);
          }
        }
        const fetched = await productsRepo.findActiveBySlugs(rawSlugs);
        const bySlug = new Map(fetched.map((r) => [r.slug, r]));
        orderedRows = rawSlugs.flatMap((slug) => {
          const found = bySlug.get(slug);
          return found !== undefined ? [found] : [];
        });
      }

      if (orderedRows.length < COMPARE_MIN_ITEMS) {
        throw new NotFoundError(
          'At least 2 active products are required for comparison',
          'COMPARE_PRODUCTS_NOT_FOUND',
        );
      }

      const uniqueCatIds = [...new Set(orderedRows.map((r) => r.categoryId))];
      const schemasEntries = await Promise.all(
        uniqueCatIds.map(async (catId) => {
          const info = await resolveCategoryWithSchema(catId);
          return [catId, info.effectiveSpecSchema] as const;
        }),
      );
      const schemaByCatId = new Map(schemasEntries);

      // Build deterministic union of specSchema definitions across compared products
      const mergedDefsMap = new Map<string, SpecFieldDef>();
      for (const row of orderedRows) {
        const defs = schemaByCatId.get(row.categoryId) ?? [];
        for (const def of defs) {
          if (!mergedDefsMap.has(def.key)) {
            mergedDefsMap.set(def.key, def);
          }
        }
      }
      const unionSchema = [...mergedDefsMap.values()].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key),
      );

      return {
        specSchema: unionSchema,
        products: orderedRows.map((row) =>
          serializeProductDetail(row, schemaByCatId.get(row.categoryId) ?? []),
        ),
      };
    },

    async listRecommendations(query: RecommendationsQuery): Promise<readonly ProductCard[]> {
      const rows = await productsRepo.listRecommendations({
        ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
        ...(query.excludeProductId !== undefined
          ? { excludeProductId: query.excludeProductId }
          : {}),
        limit: query.limit,
      });
      return rows.map(serializeProductCard);
    },

    async listProductSpareparts(
      productId: string,
      query: ListProductSparepartsQuery,
    ): Promise<CursorPage<ProductSparepartLinkItem>> {
      const existing = await productsRepo.findById(productId);
      if (existing === null || !isRecordActive(existing)) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      const decodedCursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;
      const rows = await productsRepo.listSparepartsCursor({
        parentProductId: productId,
        limit: query.limit + 1,
        ...(decodedCursor !== undefined ? { cursor: decodedCursor } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });

      return buildCursorPage(rows, query.limit, serializeSparepartItem);
    },

    async resolveRelatedProductCards(
      productIds: readonly string[],
    ): Promise<readonly RelatedProductCard[]> {
      const cards = await productsRepo.findActiveCardsByIds(productIds);
      return cards.map((card) => ({
        id: card.id,
        name: card.name,
        slug: card.slug,
        priceIdr: card.priceIdr,
        requiresQuote: card.requiresQuote,
        primaryImageUrl: card.primaryImageUrl,
        stock: card.stock,
      }));
    },

    async listAdminProducts(
      actor: AuthUser,
      query: ListAdminProductsQuery,
    ): Promise<CursorPage<ProductCard>> {
      assertAdminUser(actor);

      const filters = {
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
        ...(query.brandSlug !== undefined ? { brandSlugs: query.brandSlug } : {}),
        ...(query.type !== undefined ? { productType: query.type } : {}),
        ...(query.isFeatured !== undefined ? { isFeatured: query.isFeatured } : {}),
        ...(query.requiresQuote !== undefined ? { requiresQuote: query.requiresQuote } : {}),
        ...(query.inStock !== undefined ? { inStock: query.inStock } : {}),
        ...(query.createdFrom !== undefined ? { createdFrom: query.createdFrom } : {}),
        ...(query.createdTo !== undefined ? { createdTo: query.createdTo } : {}),
      };

      return paginateAdminList({
        query,
        listOffset: ({ limit, offset }) =>
          productsRepo.listAdminOffset({ limit, offset, ...filters }),
        listCursor: ({ limit, cursor }) =>
          productsRepo.listAdminCursor({
            limit,
            ...(cursor !== undefined ? { cursor } : {}),
            ...filters,
          }),
        serialize: serializeProductCard,
      });
    },

    async getAdminProductById(actor: AuthUser, id: string): Promise<ProductDetail> {
      assertAdminUser(actor);
      const product = await productsRepo.findById(id);
      if (product === null) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }
      const schemaInfo = await resolveCategoryWithSchema(product.categoryId);
      const spareparts = await productsRepo.listSparepartsCursor({
        parentProductId: product.id,
        limit: 50,
      });
      return serializeProductDetail(product, schemaInfo.effectiveSpecSchema, {
        spareparts: spareparts.map(serializeSparepartItem),
      });
    },

    async createProduct(actor: AuthUser, input: CreateProductBody): Promise<ProductDetail> {
      assertAdminUser(actor);

      const schemaInfo = await resolveCategoryWithSchema(input.categoryId);
      if (!isRecordActive(schemaInfo.category)) {
        throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
      }
      validateSpecsAgainstSchema(input.specs, schemaInfo.effectiveSpecSchema);

      const resolvedActive = resolveActiveStateInput(input) ?? true;
      const resolvedSlug = input.slug ?? slugify(input.name, 260);
      const { media, primaryImageUrl } = normalizeMediaItems(input.media);

      const created = await productsRepo.create({
        id: generateId(),
        categoryId: input.categoryId,
        brandSlug: input.brandSlug ?? null,
        name: input.name,
        slug: resolvedSlug,
        sku: input.sku ?? null,
        productType: input.productType,
        descriptionMd: input.descriptionMd ?? null,
        metaTitle: input.metaTitle ?? null,
        metaDescription: input.metaDescription ?? null,
        focusKeyword: input.focusKeyword ?? null,
        canonicalUrl: input.canonicalUrl ?? null,
        noIndex: input.noIndex,
        ogImageUrl: input.ogImageUrl ?? null,
        priceIdr: input.priceIdr,
        requiresQuote: input.requiresQuote,
        stock: input.stock,
        isFeatured: input.isFeatured,
        isActive: resolvedActive,
        deletedAt: resolvedActive ? null : new Date(),
        primaryImageUrl,
        media,
        specs: input.specs,
        customSpecs: normalizeCustomSpecs(input.customSpecs),
        lengthCm: formatNumericInput(input.lengthCm),
        widthCm: formatNumericInput(input.widthCm),
        heightCm: formatNumericInput(input.heightCm),
        weightKg: formatNumericInput(input.weightKg),
      });

      revalidator.notify(['products', `product:${created.slug}`, 'sitemap']);
      return serializeProductDetail(created, schemaInfo.effectiveSpecSchema);
    },

    async updateProduct(
      actor: AuthUser,
      id: string,
      input: UpdateProductBody,
    ): Promise<ProductDetail> {
      assertAdminUser(actor);

      const existing = await productsRepo.findById(id);
      if (existing === null) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      const nextCategoryId = input.categoryId ?? existing.categoryId;
      const schemaInfo = await resolveCategoryWithSchema(nextCategoryId);
      if (
        input.categoryId !== undefined &&
        input.categoryId !== existing.categoryId &&
        !isRecordActive(schemaInfo.category)
      ) {
        throw new NotFoundError('Category not found', 'CATEGORY_NOT_FOUND');
      }
      const nextSpecs = input.specs ?? existing.specs;
      validateSpecsAgainstSchema(nextSpecs, schemaInfo.effectiveSpecSchema);

      const nextActive = resolveActiveStateInput(input);
      const activePatch =
        nextActive !== undefined
          ? {
              isActive: nextActive,
              deletedAt: nextActive ? null : (existing.deletedAt ?? new Date()),
            }
          : {};

      const normalizedMedia =
        input.media !== undefined ? normalizeMediaItems(input.media) : undefined;

      const updated = await productsRepo.updateById(id, {
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.brandSlug !== undefined ? { brandSlug: input.brandSlug } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.sku !== undefined ? { sku: input.sku } : {}),
        ...(input.productType !== undefined ? { productType: input.productType } : {}),
        ...(input.descriptionMd !== undefined ? { descriptionMd: input.descriptionMd } : {}),
        ...(input.metaTitle !== undefined ? { metaTitle: input.metaTitle } : {}),
        ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
        ...(input.focusKeyword !== undefined ? { focusKeyword: input.focusKeyword } : {}),
        ...(input.canonicalUrl !== undefined ? { canonicalUrl: input.canonicalUrl } : {}),
        ...(input.noIndex !== undefined ? { noIndex: input.noIndex } : {}),
        ...(input.ogImageUrl !== undefined ? { ogImageUrl: input.ogImageUrl } : {}),
        ...(input.priceIdr !== undefined ? { priceIdr: input.priceIdr } : {}),
        ...(input.requiresQuote !== undefined ? { requiresQuote: input.requiresQuote } : {}),
        ...(input.stock !== undefined ? { stock: input.stock } : {}),
        ...(input.isFeatured !== undefined ? { isFeatured: input.isFeatured } : {}),
        ...activePatch,
        ...(normalizedMedia !== undefined
          ? {
              media: normalizedMedia.media,
              primaryImageUrl: normalizedMedia.primaryImageUrl,
            }
          : {}),
        ...(input.specs !== undefined ? { specs: input.specs } : {}),
        ...(input.customSpecs !== undefined
          ? { customSpecs: normalizeCustomSpecs(input.customSpecs) }
          : {}),
        ...(input.lengthCm !== undefined ? { lengthCm: formatNumericInput(input.lengthCm) } : {}),
        ...(input.widthCm !== undefined ? { widthCm: formatNumericInput(input.widthCm) } : {}),
        ...(input.heightCm !== undefined ? { heightCm: formatNumericInput(input.heightCm) } : {}),
        ...(input.weightKg !== undefined ? { weightKg: formatNumericInput(input.weightKg) } : {}),
      });

      if (updated === null) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      revalidator.notify([
        'products',
        `product:${existing.slug}`,
        `product:${updated.slug}`,
        'sitemap',
      ]);

      return serializeProductDetail(updated, schemaInfo.effectiveSpecSchema);
    },

    async deleteProduct(actor: AuthUser, id: string): Promise<void> {
      assertAdminUser(actor);

      const existing = await productsRepo.findById(id);
      if (existing === null) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      await productsRepo.softDeleteById(id, existing.deletedAt ?? new Date());
      revalidator.notify(['products', `product:${existing.slug}`, 'sitemap']);
    },

    async replaceProductSpareparts(
      actor: AuthUser,
      productId: string,
      body: ReplaceSparepartsBody,
    ): Promise<readonly ProductSparepartLinkItem[]> {
      assertAdminUser(actor);

      const parent = await productsRepo.findById(productId);
      if (parent === null) {
        throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
      }

      for (const item of body.items) {
        if (item.sparepartProductId === productId) {
          throw new ValidationError('A product cannot link to itself as a spare part', [
            {
              field: 'items',
              message: 'sparepartProductId must not equal parent product id',
            },
          ]);
        }
      }

      if (body.items.length > 0) {
        const targetIds = body.items.map((i) => i.sparepartProductId);
        const foundTargets = await Promise.all(targetIds.map((id) => productsRepo.findById(id)));
        const missingIdx = foundTargets.findIndex((r) => r === null);
        if (missingIdx !== -1) {
          throw new NotFoundError(
            `Spare part product "${targetIds[missingIdx]}" not found`,
            'SPAREPART_PRODUCT_NOT_FOUND',
          );
        }
      }

      const linked = await productsRepo.replaceSpareparts(productId, body.items);
      revalidator.notify(['products', `product:${parent.slug}`]);
      return linked.map(serializeSparepartItem);
    },
  };
}
