import type { ArticleRow } from '@/db/schema/articles.ts';
import type { CategoryRow } from '@/db/schema/categories.ts';
import type { MediaUploadRow } from '@/db/schema/media-uploads.ts';
import type { PasswordResetTokenRow } from '@/db/schema/password-reset-tokens.ts';
import type { ProductReviewRow } from '@/db/schema/product-reviews.ts';
import type { ProductRow } from '@/db/schema/products.ts';
import { extractReferencedObjectPaths } from '@/lib/asset-url.ts';
import { ConflictError } from '@/lib/errors.ts';
import type {
  ArticlesRepository,
  ArticleSummaryRow,
} from '@/modules/articles/articles.repository.ts';
import type {
  AuthRepository,
  NewRefreshTokenInput,
  RefreshTokenEntity,
  RefreshTokenWithUser,
} from '@/modules/auth/auth.repository.ts';
import type { CatalogRepository } from '@/modules/catalog/catalog.repository.ts';
import type { MediaRepository } from '@/modules/media/media.repository.ts';
import type {
  ProductCardRow,
  ProductSparepartCardRow,
  ProductsRepository,
} from '@/modules/products/products.repository.ts';
import type {
  ProductReviewWithAuthorRow,
  ReviewsRepository,
} from '@/modules/reviews/reviews.repository.ts';
import type {
  UserEntity,
  UsersRepository,
  UserWithCredentials,
} from '@/modules/users/users.repository.ts';
import type { UserRole } from '@/types/app.ts';

type StoredUser = UserWithCredentials;

export interface InMemoryDatastore {
  readonly authRepo: AuthRepository;
  readonly usersRepo: UsersRepository;
  readonly catalogRepo: CatalogRepository;
  readonly productsRepo: ProductsRepository;
  readonly reviewsRepo: ReviewsRepository;
  readonly articlesRepo: ArticlesRepository;
  readonly mediaRepo: MediaRepository;
  seedUser(params: {
    readonly id: string;
    readonly email: string;
    readonly passwordHash: string | null;
    readonly googleSub?: string | null;
    readonly phone?: string | null;
    readonly displayName: string;
    readonly role?: UserRole;
    readonly createdAt?: Date;
  }): UserEntity;
  seedMediaUpload(params: {
    readonly id: string;
    readonly bucket: string;
    readonly objectPath: string;
    readonly publicUrl: string;
    readonly contentType: string;
    readonly uploadedBy: string;
    readonly createdAt: Date;
  }): MediaUploadRow;
}

function toPublicEntity(stored: StoredUser): UserEntity {
  return {
    id: stored.id,
    email: stored.email,
    phone: stored.phone,
    displayName: stored.displayName,
    role: stored.role,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function toArticleSummary(row: ArticleRow): ArticleSummaryRow {
  return {
    id: row.id,
    authorId: row.authorId,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    coverImageUrl: row.coverImageUrl,
    metaTitle: row.metaTitle,
    metaDescription: row.metaDescription,
    tags: [...row.tags],
    isPublished: row.isPublished,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProductCardRow(row: ProductRow): ProductCardRow {
  return {
    id: row.id,
    categoryId: row.categoryId,
    brandSlug: row.brandSlug,
    name: row.name,
    slug: row.slug,
    sku: row.sku,
    productType: row.productType,
    priceIdr: row.priceIdr,
    requiresQuote: row.requiresQuote,
    stock: row.stock,
    isFeatured: row.isFeatured,
    isActive: row.isActive,
    primaryImageUrl: row.primaryImageUrl,
    ratingAvg: row.ratingAvg,
    reviewCount: row.reviewCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createInMemoryDatastore(): InMemoryDatastore {
  const usersById = new Map<string, StoredUser>();
  const tokensById = new Map<string, RefreshTokenEntity>();
  const resetTokensById = new Map<string, PasswordResetTokenRow>();
  const categoriesById = new Map<string, CategoryRow>();
  const productsById = new Map<string, ProductRow>();
  const sparepartsByParent = new Map<
    string,
    { readonly sparepartProductId: string; readonly note: string | null }[]
  >();
  const reviewsById = new Map<string, ProductReviewRow>();
  const articlesById = new Map<string, ArticleRow>();
  const mediaUploadsById = new Map<string, MediaUploadRow>();

  const findStoredByEmail = (email: string): StoredUser | null => {
    const normalized = email.trim().toLowerCase();
    for (const user of usersById.values()) {
      if (user.email === normalized) {
        return user;
      }
    }
    return null;
  };

  const insertToken = (input: NewRefreshTokenInput): void => {
    tokensById.set(input.id, {
      id: input.id,
      userId: input.userId,
      familyId: input.familyId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
      replacedByTokenId: null,
      createdAt: new Date(),
    });
  };

  const recomputeProductRating = (productId: string): void => {
    const prod = productsById.get(productId);
    if (prod === undefined) return;
    const pubReviews = [...reviewsById.values()].filter(
      (r) => r.productId === productId && r.isPublished,
    );
    const count = pubReviews.length;
    const avg =
      count === 0 ? '0.00' : (pubReviews.reduce((acc, r) => acc + r.rating, 0) / count).toFixed(2);
    productsById.set(productId, {
      ...prod,
      ratingAvg: avg,
      reviewCount: count,
      updatedAt: new Date(),
    });
  };

  const authRepo: AuthRepository = {
    findUserByEmailWithCredentials(email: string): Promise<UserWithCredentials | null> {
      const found = findStoredByEmail(email);
      return Promise.resolve(found !== null ? { ...found } : null);
    },

    findUserByGoogleSub(googleSub: string): Promise<UserEntity | null> {
      for (const user of usersById.values()) {
        if (user.googleSub === googleSub) {
          return Promise.resolve(toPublicEntity(user));
        }
      }
      return Promise.resolve(null);
    },

    createUserWithRefreshToken({ user, refreshToken }): Promise<UserEntity> {
      if (findStoredByEmail(user.email) !== null) {
        return Promise.reject(
          new ConflictError('An account with this email already exists', 'EMAIL_ALREADY_EXISTS'),
        );
      }

      const now = new Date();
      const stored: StoredUser = {
        id: user.id,
        email: user.email.trim().toLowerCase(),
        passwordHash: user.passwordHash,
        googleSub: user.googleSub ?? null,
        phone: user.phone ?? null,
        displayName: user.displayName,
        role: user.role,
        createdAt: now,
        updatedAt: now,
      };
      usersById.set(stored.id, stored);
      insertToken(refreshToken);

      return Promise.resolve(toPublicEntity(stored));
    },

    linkGoogleSubAndInsertRefreshToken({ userId, googleSub, refreshToken }): Promise<UserEntity> {
      const existing = usersById.get(userId);
      if (existing === undefined) {
        return Promise.reject(new Error('User not found'));
      }
      for (const other of usersById.values()) {
        if (other.id !== userId && other.googleSub === googleSub) {
          return Promise.reject(
            new ConflictError('Google account already linked', 'GOOGLE_ALREADY_LINKED'),
          );
        }
      }
      const updated: StoredUser = {
        ...existing,
        googleSub,
        updatedAt: new Date(),
      };
      usersById.set(userId, updated);
      insertToken(refreshToken);
      return Promise.resolve(toPublicEntity(updated));
    },

    insertRefreshToken(token: NewRefreshTokenInput): Promise<void> {
      insertToken(token);
      return Promise.resolve();
    },

    findRefreshTokenWithUserByHash(tokenHash: string): Promise<RefreshTokenWithUser | null> {
      for (const token of tokensById.values()) {
        if (token.tokenHash === tokenHash) {
          const owner = usersById.get(token.userId);
          if (owner === undefined) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            token: { ...token },
            user: toPublicEntity(owner),
          });
        }
      }
      return Promise.resolve(null);
    },

    rotateRefreshToken({ currentTokenId, nextToken, revokedAt }): Promise<boolean> {
      const existing = tokensById.get(currentTokenId);
      if (existing === undefined || existing.revokedAt !== null) {
        return Promise.resolve(false);
      }

      tokensById.set(currentTokenId, {
        ...existing,
        revokedAt,
        replacedByTokenId: nextToken.id,
      });
      insertToken(nextToken);
      return Promise.resolve(true);
    },

    revokeTokenFamily(familyId: string, revokedAt: Date): Promise<void> {
      for (const [id, token] of tokensById.entries()) {
        if (token.familyId === familyId && token.revokedAt === null) {
          tokensById.set(id, { ...token, revokedAt });
        }
      }
      return Promise.resolve();
    },

    revokeTokenByHash(tokenHash: string, revokedAt: Date): Promise<void> {
      for (const [id, token] of tokensById.entries()) {
        if (token.tokenHash === tokenHash && token.revokedAt === null) {
          tokensById.set(id, { ...token, revokedAt });
        }
      }
      return Promise.resolve();
    },

    createPasswordResetToken(input): Promise<void> {
      resetTokensById.set(input.id, {
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        usedAt: null,
        createdAt: new Date(),
      });
      return Promise.resolve();
    },

    consumePasswordResetTokenAndUpdatePassword({ tokenHash, passwordHash, now }): Promise<boolean> {
      let target: PasswordResetTokenRow | undefined;
      for (const rt of resetTokensById.values()) {
        if (
          rt.tokenHash === tokenHash &&
          rt.usedAt === null &&
          rt.expiresAt.getTime() > now.getTime()
        ) {
          target = rt;
          break;
        }
      }
      if (target === undefined) {
        return Promise.resolve(false);
      }

      const user = usersById.get(target.userId);
      if (user === undefined) {
        return Promise.resolve(false);
      }

      usersById.set(user.id, { ...user, passwordHash, updatedAt: now });

      for (const [id, rt] of resetTokensById.entries()) {
        if (rt.userId === user.id && rt.usedAt === null) {
          resetTokensById.set(id, { ...rt, usedAt: now });
        }
      }
      for (const [id, tok] of tokensById.entries()) {
        if (tok.userId === user.id && tok.revokedAt === null) {
          tokensById.set(id, { ...tok, revokedAt: now });
        }
      }
      return Promise.resolve(true);
    },
  };

  const usersRepo: UsersRepository = {
    findById(id: string): Promise<UserEntity | null> {
      const stored = usersById.get(id);
      return Promise.resolve(stored !== undefined ? toPublicEntity(stored) : null);
    },

    findByEmailWithCredentials(email: string): Promise<UserWithCredentials | null> {
      const found = findStoredByEmail(email);
      return Promise.resolve(found !== null ? { ...found } : null);
    },

    updateProfile(id, patch): Promise<UserEntity | null> {
      const existing = usersById.get(id);
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      const updated: StoredUser = {
        ...existing,
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        updatedAt: new Date(),
      };
      usersById.set(id, updated);
      return Promise.resolve(toPublicEntity(updated));
    },

    listCursor({ limit, cursor }): Promise<readonly UserEntity[]> {
      const sorted = [...usersById.values()].sort((a, b) => {
        const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (timeDiff !== 0) {
          return timeDiff;
        }
        return b.id.localeCompare(a.id);
      });

      const filtered =
        cursor !== undefined
          ? sorted.filter((item) => {
              const itemMs = item.createdAt.getTime();
              const cursorMs = cursor.createdAt.getTime();
              return itemMs < cursorMs || (itemMs === cursorMs && item.id < cursor.id);
            })
          : sorted;

      return Promise.resolve(filtered.slice(0, limit).map(toPublicEntity));
    },
  };

  const sortCategories = (rows: CategoryRow[]): CategoryRow[] =>
    rows.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );

  const catalogRepo: CatalogRepository = {
    listActive(): Promise<readonly CategoryRow[]> {
      const active = [...categoriesById.values()].filter(
        (row) => row.deletedAt === null && row.isActive,
      );
      return Promise.resolve(sortCategories(active));
    },

    listAllNonDeleted(): Promise<readonly CategoryRow[]> {
      const rows = [...categoriesById.values()].filter((row) => row.deletedAt === null);
      return Promise.resolve(sortCategories(rows));
    },

    findById(id: string): Promise<CategoryRow | null> {
      const found = categoriesById.get(id);
      return Promise.resolve(found !== undefined && found.deletedAt === null ? found : null);
    },

    findActiveBySlug(slug: string): Promise<CategoryRow | null> {
      for (const row of categoriesById.values()) {
        if (row.slug === slug && row.isActive && row.deletedAt === null) {
          return Promise.resolve(row);
        }
      }
      return Promise.resolve(null);
    },

    listActiveChildren(parentId: string): Promise<readonly CategoryRow[]> {
      const children = [...categoriesById.values()].filter(
        (row) => row.parentId === parentId && row.isActive && row.deletedAt === null,
      );
      return Promise.resolve(sortCategories(children));
    },

    hasNonDeletedChildren(parentId: string): Promise<boolean> {
      for (const row of categoriesById.values()) {
        if (row.parentId === parentId && row.deletedAt === null) {
          return Promise.resolve(true);
        }
      }
      return Promise.resolve(false);
    },

    hasNonDeletedProducts(categoryId: string): Promise<boolean> {
      for (const row of productsById.values()) {
        if (row.categoryId === categoryId && row.deletedAt === null) {
          return Promise.resolve(true);
        }
      }
      return Promise.resolve(false);
    },

    create(input): Promise<CategoryRow> {
      for (const existing of categoriesById.values()) {
        if (existing.deletedAt === null && existing.slug === input.slug) {
          return Promise.reject(
            new ConflictError('A category with this slug already exists', 'SLUG_ALREADY_EXISTS'),
          );
        }
      }
      const now = new Date();
      const created: CategoryRow = {
        id: input.id,
        parentId: input.parentId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        metaTitle: input.metaTitle,
        metaDescription: input.metaDescription,
        imageUrl: input.imageUrl,
        bannerImageUrl: input.bannerImageUrl,
        specSchema: [...input.specSchema],
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      categoriesById.set(created.id, created);
      return Promise.resolve(created);
    },

    updateById(id, patch): Promise<CategoryRow | null> {
      const existing = categoriesById.get(id);
      if (existing === undefined || existing.deletedAt !== null) {
        return Promise.resolve(null);
      }
      if (patch.slug !== undefined) {
        for (const other of categoriesById.values()) {
          if (other.id !== id && other.deletedAt === null && other.slug === patch.slug) {
            return Promise.reject(
              new ConflictError('A category with this slug already exists', 'SLUG_ALREADY_EXISTS'),
            );
          }
        }
      }
      const updated: CategoryRow = {
        ...existing,
        ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.metaTitle !== undefined ? { metaTitle: patch.metaTitle } : {}),
        ...(patch.metaDescription !== undefined ? { metaDescription: patch.metaDescription } : {}),
        ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl } : {}),
        ...(patch.bannerImageUrl !== undefined ? { bannerImageUrl: patch.bannerImageUrl } : {}),
        ...(patch.specSchema !== undefined ? { specSchema: [...patch.specSchema] } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        updatedAt: new Date(),
      };
      categoriesById.set(id, updated);
      return Promise.resolve(updated);
    },

    softDeleteById(id, deletedAt): Promise<boolean> {
      const existing = categoriesById.get(id);
      if (existing === undefined || existing.deletedAt !== null) {
        return Promise.resolve(false);
      }
      categoriesById.set(id, { ...existing, deletedAt, updatedAt: deletedAt });
      return Promise.resolve(true);
    },

    listSitemapIndex() {
      const cats = [...categoriesById.values()]
        .filter((r) => r.deletedAt === null && r.isActive)
        .map((r) => ({ slug: r.slug, updatedAt: r.updatedAt }));
      const prods = [...productsById.values()]
        .filter((r) => r.deletedAt === null && r.isActive)
        .map((r) => ({ slug: r.slug, updatedAt: r.updatedAt }));
      const arts = [...articlesById.values()]
        .filter((r) => r.deletedAt === null && r.isPublished)
        .map((r) => ({ slug: r.slug, updatedAt: r.updatedAt }));
      return Promise.resolve({ categories: cats, products: prods, articles: arts });
    },
  };

  const sortProductsDesc = (rows: ProductRow[]): ProductRow[] =>
    rows.sort((a, b) => {
      const diff = b.createdAt.getTime() - a.createdAt.getTime();
      return diff !== 0 ? diff : b.id.localeCompare(a.id);
    });

  const productsRepo: ProductsRepository = {
    listPublicCursor(filter): Promise<readonly ProductCardRow[]> {
      const terms =
        filter.query !== undefined
          ? filter.query
              .toLowerCase()
              .split(/\s+/)
              .filter((t) => t.length > 0)
          : [];

      const matching = [...productsById.values()].filter((row) => {
        if (row.deletedAt !== null || !row.isActive) return false;
        if (filter.categoryIds !== undefined && !filter.categoryIds.includes(row.categoryId)) {
          return false;
        }
        if (filter.brandSlug !== undefined && row.brandSlug !== filter.brandSlug) return false;
        if (filter.isFeatured !== undefined && row.isFeatured !== filter.isFeatured) return false;
        if (filter.productType !== undefined && row.productType !== filter.productType) {
          return false;
        }
        if (filter.requiresQuote !== undefined && row.requiresQuote !== filter.requiresQuote) {
          return false;
        }
        if (filter.minPrice !== undefined && row.priceIdr < filter.minPrice) return false;
        if (filter.maxPrice !== undefined && row.priceIdr > filter.maxPrice) return false;
        if (terms.length > 0) {
          const haystack = [row.name, row.sku ?? '', row.brandSlug ?? '', row.descriptionMd ?? '']
            .join(' ')
            .toLowerCase();
          if (!terms.every((t) => haystack.includes(t))) return false;
        }
        return true;
      });

      const sorted = sortProductsDesc(matching);
      const afterCursor =
        filter.cursor !== undefined
          ? sorted.filter((r) => {
              const rMs = r.createdAt.getTime();
              const cMs = filter.cursor?.createdAt.getTime() ?? 0;
              const cId = filter.cursor?.id ?? '';
              return rMs < cMs || (rMs === cMs && r.id < cId);
            })
          : sorted;

      return Promise.resolve(afterCursor.slice(0, filter.limit).map(toProductCardRow));
    },

    listAdminCursor({ limit, cursor }): Promise<readonly ProductCardRow[]> {
      const sorted = sortProductsDesc(
        [...productsById.values()].filter((r) => r.deletedAt === null),
      );
      const filtered =
        cursor !== undefined
          ? sorted.filter((r) => {
              const rMs = r.createdAt.getTime();
              const cMs = cursor.createdAt.getTime();
              return rMs < cMs || (rMs === cMs && r.id < cursor.id);
            })
          : sorted;
      return Promise.resolve(filtered.slice(0, limit).map(toProductCardRow));
    },

    findActiveBySlug(slug): Promise<ProductRow | null> {
      for (const row of productsById.values()) {
        if (row.slug === slug && row.isActive && row.deletedAt === null) {
          return Promise.resolve(row);
        }
      }
      return Promise.resolve(null);
    },

    findById(id): Promise<ProductRow | null> {
      const row = productsById.get(id);
      return Promise.resolve(row !== undefined && row.deletedAt === null ? row : null);
    },

    findActiveByIds(ids): Promise<readonly ProductRow[]> {
      return Promise.resolve(
        ids.flatMap((id) => {
          const r = productsById.get(id);
          return r !== undefined && r.isActive && r.deletedAt === null ? [r] : [];
        }),
      );
    },

    findActiveBySlugs(slugs): Promise<readonly ProductRow[]> {
      const active = [...productsById.values()].filter((r) => r.isActive && r.deletedAt === null);
      return Promise.resolve(active.filter((r) => slugs.includes(r.slug)));
    },

    findActiveCardsByIds(ids): Promise<readonly ProductCardRow[]> {
      return Promise.resolve(
        ids.flatMap((id) => {
          const r = productsById.get(id);
          return r !== undefined && r.isActive && r.deletedAt === null ? [toProductCardRow(r)] : [];
        }),
      );
    },

    listRecommendations({
      categoryId,
      excludeProductId,
      limit,
    }): Promise<readonly ProductCardRow[]> {
      const rows = [...productsById.values()]
        .filter((r) => {
          if (r.deletedAt !== null || !r.isActive) return false;
          if (excludeProductId !== undefined && r.id === excludeProductId) return false;
          if (categoryId !== undefined && r.categoryId !== categoryId) return false;
          return true;
        })
        .sort((a, b) => {
          if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1;
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
      return Promise.resolve(rows.slice(0, limit).map(toProductCardRow));
    },

    listSparepartsCursor({
      parentProductId,
      limit,
      cursor,
    }): Promise<readonly ProductSparepartCardRow[]> {
      const links = sparepartsByParent.get(parentProductId) ?? [];
      const joined: ProductSparepartCardRow[] = [];
      for (const link of links) {
        const sp = productsById.get(link.sparepartProductId);
        if (sp !== undefined && sp.deletedAt === null && sp.isActive) {
          joined.push({ ...toProductCardRow(sp), note: link.note });
        }
      }
      joined.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const filtered =
        cursor !== undefined
          ? joined.filter((r) => {
              const rMs = r.createdAt.getTime();
              const cMs = cursor.createdAt.getTime();
              return rMs < cMs || (rMs === cMs && r.id < cursor.id);
            })
          : joined;
      return Promise.resolve(filtered.slice(0, limit));
    },

    async replaceSpareparts(parentProductId, items): Promise<readonly ProductSparepartCardRow[]> {
      sparepartsByParent.set(
        parentProductId,
        items.map((i) => ({ sparepartProductId: i.sparepartProductId, note: i.note ?? null })),
      );
      return this.listSparepartsCursor({ parentProductId, limit: 50 });
    },

    create(input): Promise<ProductRow> {
      for (const existing of productsById.values()) {
        if (existing.deletedAt !== null) continue;
        if (existing.slug === input.slug) {
          return Promise.reject(
            new ConflictError('A product with this slug already exists', 'SLUG_ALREADY_EXISTS'),
          );
        }
        if (input.sku !== null && existing.sku === input.sku) {
          return Promise.reject(
            new ConflictError('A product with this SKU already exists', 'SKU_ALREADY_EXISTS'),
          );
        }
      }
      const now = new Date();
      const created: ProductRow = {
        id: input.id,
        categoryId: input.categoryId,
        brandSlug: input.brandSlug,
        name: input.name,
        slug: input.slug,
        sku: input.sku,
        productType: input.productType,
        descriptionMd: input.descriptionMd,
        metaTitle: input.metaTitle,
        metaDescription: input.metaDescription,
        priceIdr: input.priceIdr,
        requiresQuote: input.requiresQuote,
        stock: input.stock,
        isFeatured: input.isFeatured,
        isActive: input.isActive,
        primaryImageUrl: input.primaryImageUrl,
        media: [...input.media],
        specs: { ...input.specs },
        lengthCm: input.lengthCm,
        widthCm: input.widthCm,
        heightCm: input.heightCm,
        weightKg: input.weightKg,
        ratingAvg: '0.00',
        reviewCount: 0,
        searchVector: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      productsById.set(created.id, created);
      return Promise.resolve(created);
    },

    updateById(id, patch): Promise<ProductRow | null> {
      const existing = productsById.get(id);
      if (existing === undefined || existing.deletedAt !== null) {
        return Promise.resolve(null);
      }
      for (const other of productsById.values()) {
        if (other.id === id || other.deletedAt !== null) continue;
        if (patch.slug !== undefined && other.slug === patch.slug) {
          return Promise.reject(
            new ConflictError('A product with this slug already exists', 'SLUG_ALREADY_EXISTS'),
          );
        }
        if (patch.sku !== undefined && patch.sku !== null && other.sku === patch.sku) {
          return Promise.reject(
            new ConflictError('A product with this SKU already exists', 'SKU_ALREADY_EXISTS'),
          );
        }
      }
      const updated: ProductRow = {
        ...existing,
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.brandSlug !== undefined ? { brandSlug: patch.brandSlug } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.sku !== undefined ? { sku: patch.sku } : {}),
        ...(patch.productType !== undefined ? { productType: patch.productType } : {}),
        ...(patch.descriptionMd !== undefined ? { descriptionMd: patch.descriptionMd } : {}),
        ...(patch.metaTitle !== undefined ? { metaTitle: patch.metaTitle } : {}),
        ...(patch.metaDescription !== undefined ? { metaDescription: patch.metaDescription } : {}),
        ...(patch.priceIdr !== undefined ? { priceIdr: patch.priceIdr } : {}),
        ...(patch.requiresQuote !== undefined ? { requiresQuote: patch.requiresQuote } : {}),
        ...(patch.stock !== undefined ? { stock: patch.stock } : {}),
        ...(patch.isFeatured !== undefined ? { isFeatured: patch.isFeatured } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.primaryImageUrl !== undefined ? { primaryImageUrl: patch.primaryImageUrl } : {}),
        ...(patch.media !== undefined ? { media: [...patch.media] } : {}),
        ...(patch.specs !== undefined ? { specs: { ...patch.specs } } : {}),
        ...(patch.lengthCm !== undefined ? { lengthCm: patch.lengthCm } : {}),
        ...(patch.widthCm !== undefined ? { widthCm: patch.widthCm } : {}),
        ...(patch.heightCm !== undefined ? { heightCm: patch.heightCm } : {}),
        ...(patch.weightKg !== undefined ? { weightKg: patch.weightKg } : {}),
        updatedAt: new Date(),
      };
      productsById.set(id, updated);
      return Promise.resolve(updated);
    },

    softDeleteById(id, deletedAt): Promise<boolean> {
      const existing = productsById.get(id);
      if (existing === undefined || existing.deletedAt !== null) {
        return Promise.resolve(false);
      }
      productsById.set(id, { ...existing, deletedAt, updatedAt: deletedAt });
      return Promise.resolve(true);
    },
  };

  const toReviewWithAuthor = (row: ProductReviewRow): ProductReviewWithAuthorRow => ({
    id: row.id,
    productId: row.productId,
    userId: row.userId,
    authorName: usersById.get(row.userId)?.displayName ?? 'Customer',
    orderId: row.orderId,
    rating: row.rating,
    comment: row.comment,
    isPublished: row.isPublished,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const reviewsRepo: ReviewsRepository = {
    listPublishedByProductCursor({ productId, limit, cursor }) {
      const published = [...reviewsById.values()]
        .filter((r) => r.productId === productId && r.isPublished)
        .sort((a, b) => {
          const diff = b.createdAt.getTime() - a.createdAt.getTime();
          return diff !== 0 ? diff : b.id.localeCompare(a.id);
        });

      const filtered =
        cursor !== undefined
          ? published.filter((r) => {
              const rMs = r.createdAt.getTime();
              const cMs = cursor.createdAt.getTime();
              return rMs < cMs || (rMs === cMs && r.id < cursor.id);
            })
          : published;

      return Promise.resolve(filtered.slice(0, limit).map(toReviewWithAuthor));
    },

    createAndSyncProductRating(input) {
      for (const existing of reviewsById.values()) {
        if (existing.productId === input.productId && existing.userId === input.userId) {
          return Promise.reject(
            new ConflictError(
              'You have already submitted a review for this product',
              'REVIEW_ALREADY_EXISTS',
            ),
          );
        }
      }
      const now = new Date();
      const created: ProductReviewRow = {
        id: input.id,
        productId: input.productId,
        userId: input.userId,
        orderId: input.orderId,
        rating: input.rating,
        comment: input.comment,
        isPublished: true,
        createdAt: now,
        updatedAt: now,
      };
      reviewsById.set(created.id, created);
      recomputeProductRating(input.productId);
      return Promise.resolve(toReviewWithAuthor(created));
    },

    updatePublishStateAndSyncRating(reviewId, isPublished) {
      const existing = reviewsById.get(reviewId);
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      const updated: ProductReviewRow = {
        ...existing,
        isPublished,
        updatedAt: new Date(),
      };
      reviewsById.set(reviewId, updated);
      recomputeProductRating(updated.productId);
      return Promise.resolve(toReviewWithAuthor(updated));
    },

    deleteAndSyncRating(reviewId) {
      const existing = reviewsById.get(reviewId);
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      reviewsById.delete(reviewId);
      recomputeProductRating(existing.productId);
      return Promise.resolve({ productId: existing.productId });
    },
  };

  const articlesRepo: ArticlesRepository = {
    listPublishedCursor({ limit, cursor, tag }): Promise<readonly ArticleSummaryRow[]> {
      const published = [...articlesById.values()]
        .filter((r) => {
          if (r.deletedAt !== null || !r.isPublished) return false;
          if (tag !== undefined && !r.tags.includes(tag)) return false;
          return true;
        })
        .sort((a, b) => {
          const aTime = (a.publishedAt ?? a.createdAt).getTime();
          const bTime = (b.publishedAt ?? b.createdAt).getTime();
          if (bTime !== aTime) return bTime - aTime;
          return b.id.localeCompare(a.id);
        });

      const filtered =
        cursor !== undefined
          ? published.filter((r) => {
              const rMs = (r.publishedAt ?? r.createdAt).getTime();
              const cMs = cursor.createdAt.getTime();
              return rMs < cMs || (rMs === cMs && r.id < cursor.id);
            })
          : published;

      return Promise.resolve(filtered.slice(0, limit).map(toArticleSummary));
    },

    listAdminCursor({ limit, cursor }): Promise<readonly ArticleSummaryRow[]> {
      const rows = [...articlesById.values()]
        .filter((r) => r.deletedAt === null)
        .sort((a, b) => {
          const diff = b.createdAt.getTime() - a.createdAt.getTime();
          return diff !== 0 ? diff : b.id.localeCompare(a.id);
        });

      const filtered =
        cursor !== undefined
          ? rows.filter((r) => {
              const rMs = r.createdAt.getTime();
              const cMs = cursor.createdAt.getTime();
              return rMs < cMs || (rMs === cMs && r.id < cursor.id);
            })
          : rows;

      return Promise.resolve(filtered.slice(0, limit).map(toArticleSummary));
    },

    findPublishedBySlug(slug): Promise<ArticleRow | null> {
      for (const row of articlesById.values()) {
        if (row.slug === slug && row.isPublished && row.deletedAt === null) {
          return Promise.resolve(row);
        }
      }
      return Promise.resolve(null);
    },

    findById(id): Promise<ArticleRow | null> {
      const row = articlesById.get(id);
      return Promise.resolve(row !== undefined && row.deletedAt === null ? row : null);
    },

    findRelatedPublished({ excludeId, tags, limit }): Promise<readonly ArticleSummaryRow[]> {
      const candidates = [...articlesById.values()].filter(
        (r) => r.id !== excludeId && r.isPublished && r.deletedAt === null,
      );
      const tagMatches = candidates.filter((r) => r.tags.some((t) => tags.includes(t)));
      const rest = candidates.filter((r) => !tagMatches.includes(r));
      return Promise.resolve([...tagMatches, ...rest].slice(0, limit).map(toArticleSummary));
    },

    create(input): Promise<ArticleRow> {
      for (const existing of articlesById.values()) {
        if (existing.deletedAt === null && existing.slug === input.slug) {
          return Promise.reject(
            new ConflictError('An article with this slug already exists', 'SLUG_ALREADY_EXISTS'),
          );
        }
      }
      const now = new Date();
      const created: ArticleRow = {
        id: input.id,
        authorId: input.authorId,
        title: input.title,
        slug: input.slug,
        excerpt: input.excerpt,
        contentMd: input.contentMd,
        coverImageUrl: input.coverImageUrl,
        metaTitle: input.metaTitle,
        metaDescription: input.metaDescription,
        tags: [...input.tags],
        relatedProductIds: [...input.relatedProductIds],
        isPublished: input.isPublished,
        publishedAt: input.publishedAt,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      articlesById.set(created.id, created);
      return Promise.resolve(created);
    },

    updateById(id, patch): Promise<ArticleRow | null> {
      const existing = articlesById.get(id);
      if (existing === undefined || existing.deletedAt !== null) {
        return Promise.resolve(null);
      }
      if (patch.slug !== undefined) {
        for (const other of articlesById.values()) {
          if (other.id !== id && other.deletedAt === null && other.slug === patch.slug) {
            return Promise.reject(
              new ConflictError('An article with this slug already exists', 'SLUG_ALREADY_EXISTS'),
            );
          }
        }
      }
      const updated: ArticleRow = {
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.excerpt !== undefined ? { excerpt: patch.excerpt } : {}),
        ...(patch.contentMd !== undefined ? { contentMd: patch.contentMd } : {}),
        ...(patch.coverImageUrl !== undefined ? { coverImageUrl: patch.coverImageUrl } : {}),
        ...(patch.metaTitle !== undefined ? { metaTitle: patch.metaTitle } : {}),
        ...(patch.metaDescription !== undefined ? { metaDescription: patch.metaDescription } : {}),
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
        ...(patch.relatedProductIds !== undefined
          ? { relatedProductIds: [...patch.relatedProductIds] }
          : {}),
        ...(patch.isPublished !== undefined ? { isPublished: patch.isPublished } : {}),
        ...(patch.publishedAt !== undefined ? { publishedAt: patch.publishedAt } : {}),
        updatedAt: new Date(),
      };
      articlesById.set(id, updated);
      return Promise.resolve(updated);
    },

    softDeleteById(id, deletedAt): Promise<boolean> {
      const existing = articlesById.get(id);
      if (existing === undefined || existing.deletedAt !== null) {
        return Promise.resolve(false);
      }
      articlesById.set(id, { ...existing, deletedAt, updatedAt: deletedAt });
      return Promise.resolve(true);
    },
  };

  const mediaRepo: MediaRepository = {
    recordUpload(input): Promise<MediaUploadRow> {
      const created: MediaUploadRow = {
        id: input.id,
        bucket: input.bucket,
        objectPath: input.objectPath,
        publicUrl: input.publicUrl,
        contentType: input.contentType,
        uploadedBy: input.uploadedBy,
        createdAt: new Date(),
        deletedAt: null,
      };
      mediaUploadsById.set(created.id, created);
      return Promise.resolve(created);
    },

    listSweepCandidates({ olderThan, limit }): Promise<readonly MediaUploadRow[]> {
      const rows = [...mediaUploadsById.values()]
        .filter((r) => r.deletedAt === null && r.createdAt.getTime() <= olderThan.getTime())
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return Promise.resolve(rows.slice(0, limit));
    },

    collectAllReferencedObjectPaths(bucket): Promise<ReadonlySet<string>> {
      const rawSources: (string | null | undefined)[] = [];
      for (const c of categoriesById.values()) {
        if (c.deletedAt !== null) continue;
        rawSources.push(c.imageUrl, c.bannerImageUrl, c.description);
      }
      for (const p of productsById.values()) {
        if (p.deletedAt !== null) continue;
        rawSources.push(p.primaryImageUrl, p.descriptionMd);
        for (const m of p.media) {
          rawSources.push(m.url);
        }
      }
      for (const a of articlesById.values()) {
        if (a.deletedAt !== null) continue;
        rawSources.push(a.coverImageUrl, a.contentMd);
      }
      return Promise.resolve(extractReferencedObjectPaths(rawSources, bucket));
    },

    markDeletedByIds(ids, deletedAt): Promise<void> {
      for (const id of ids) {
        const existing = mediaUploadsById.get(id);
        if (existing !== undefined) {
          mediaUploadsById.set(id, { ...existing, deletedAt });
        }
      }
      return Promise.resolve();
    },
  };

  return {
    authRepo,
    usersRepo,
    catalogRepo,
    productsRepo,
    reviewsRepo,
    articlesRepo,
    mediaRepo,
    seedUser(params): UserEntity {
      const createdAt = params.createdAt ?? new Date();
      const stored: StoredUser = {
        id: params.id,
        email: params.email.trim().toLowerCase(),
        passwordHash: params.passwordHash,
        googleSub: params.googleSub ?? null,
        phone: params.phone ?? null,
        displayName: params.displayName,
        role: params.role ?? 'user',
        createdAt,
        updatedAt: createdAt,
      };
      usersById.set(stored.id, stored);
      return toPublicEntity(stored);
    },
    seedMediaUpload(params): MediaUploadRow {
      const row: MediaUploadRow = {
        ...params,
        deletedAt: null,
      };
      mediaUploadsById.set(row.id, row);
      return row;
    },
  };
}
