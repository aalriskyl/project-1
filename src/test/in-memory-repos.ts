import { collectMediaStrings } from '@/modules/media/media-attachments.repository.ts';
import { env } from '@/config/env.ts';
import type { ArticleRow } from '@/db/schema/articles.ts';
import type { CategoryRow } from '@/db/schema/categories.ts';
import type { MediaUploadRow } from '@/db/schema/media-uploads.ts';
import type { PasswordResetTokenRow } from '@/db/schema/password-reset-tokens.ts';
import type { ProductReviewRow } from '@/db/schema/product-reviews.ts';
import type { ProductRow } from '@/db/schema/products.ts';
import { extractReferencedObjectPaths } from '@/lib/asset-url.ts';
import { ConflictError, NotFoundError } from '@/lib/errors.ts';
import { matchesFuzzyInMemory } from '@/lib/search.ts';
import { isRecordActive, type RecordStatus } from '@/lib/status.ts';
import type {
  ArticleDetailRow,
  ArticlesRepository,
  ArticleSummaryRow,
} from '@/modules/articles/articles.repository.ts';
import type {
  AuthRepository,
  NewRefreshTokenInput,
  RefreshTokenEntity,
  RefreshTokenWithUser,
} from '@/modules/auth/auth.repository.ts';
import type {
  CatalogRepository,
  CategoryWithParentRow,
} from '@/modules/catalog/catalog.repository.ts';
import type { MediaRepository } from '@/modules/media/media.repository.ts';
import type {
  ProductCardRow,
  ProductSparepartCardRow,
  ProductsRepository,
} from '@/modules/products/products.repository.ts';
import type { ProductSpecFilter } from '@/modules/products/products.schema.ts';
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

function matchesDateRange(createdAt: Date, createdFrom?: Date, createdTo?: Date): boolean {
  const ts = createdAt.getTime();
  if (createdFrom !== undefined && ts < createdFrom.getTime()) return false;
  if (createdTo !== undefined && ts > createdTo.getTime()) return false;
  return true;
}

function compareCreatedAtDesc(
  a: { readonly createdAt: Date; readonly id: string },
  b: { readonly createdAt: Date; readonly id: string },
): number {
  const diff = b.createdAt.getTime() - a.createdAt.getTime();
  return diff !== 0 ? diff : b.id.localeCompare(a.id);
}

function applyDescCursor<T extends { readonly id: string }>(
  rows: readonly T[],
  cursor: { readonly createdAt: Date; readonly id: string } | undefined,
  getTimestamp: (row: T) => Date,
): readonly T[] {
  if (cursor === undefined) {
    return rows;
  }
  const cMs = cursor.createdAt.getTime();
  return rows.filter((r) => {
    const rMs = getTimestamp(r).getTime();
    return rMs < cMs || (rMs === cMs && r.id < cursor.id);
  });
}

function matchesSpecFilter(
  specs: Record<string, string | number | boolean>,
  specFilter: ProductSpecFilter,
): boolean {
  const raw = specs[specFilter.key];
  if (raw === undefined) return false;
  if (specFilter.op === 'gt') return typeof raw === 'number' && raw > specFilter.value;
  if (specFilter.op === 'gte') return typeof raw === 'number' && raw >= specFilter.value;
  if (specFilter.op === 'lt') return typeof raw === 'number' && raw < specFilter.value;
  if (specFilter.op === 'lte') return typeof raw === 'number' && raw <= specFilter.value;
  if (specFilter.op === 'contains') {
    return typeof raw === 'string' && raw.toLowerCase().includes(specFilter.value.toLowerCase());
  }
  if (typeof specFilter.value === 'boolean') return raw === specFilter.value;
  if (typeof specFilter.value === 'number') {
    return (
      raw === specFilter.value ||
      (typeof raw === 'string' && raw.toLowerCase() === String(specFilter.value).toLowerCase())
    );
  }
  return typeof raw === 'string' && raw.toLowerCase() === specFilter.value.toLowerCase();
}

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
    readonly address?: string | null;
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

function matchesStatusFilter(
  row: { readonly isActive: boolean; readonly deletedAt: Date | null },
  status?: RecordStatus,
): boolean {
  if (status === undefined) return true;
  const active = isRecordActive(row);
  return status === 'active' ? active : !active;
}

function toPublicEntity(stored: StoredUser): UserEntity {
  return {
    id: stored.id,
    email: stored.email,
    phone: stored.phone,
    address: stored.address,
    displayName: stored.displayName,
    role: stored.role,
    isActive: stored.isActive,
    tokenVersion: stored.tokenVersion,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    deletedAt: stored.deletedAt,
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

  const toCategoryWithParent = (row: CategoryRow): CategoryWithParentRow => {
    const parent = row.parentId !== null ? (categoriesById.get(row.parentId) ?? null) : null;
    return {
      ...row,
      parentName: parent?.name ?? null,
      parentSlug: parent?.slug ?? null,
    };
  };

  const toArticleSummary = (row: ArticleRow): ArticleSummaryRow => ({
    id: row.id,
    authorId: row.authorId,
    authorName: row.authorId !== null ? (usersById.get(row.authorId)?.displayName ?? null) : null,
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
    isActive: row.isActive,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });

  const toArticleDetail = (row: ArticleRow): ArticleDetailRow => ({
    ...row,
    authorName: row.authorId !== null ? (usersById.get(row.authorId)?.displayName ?? null) : null,
  });

  const toProductCardRow = (row: ProductRow): ProductCardRow => {
    const category = categoriesById.get(row.categoryId);
    return {
      id: row.id,
      categoryId: row.categoryId,
      categoryName: category?.name ?? '',
      categorySlug: category?.slug ?? '',
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
      deletedAt: row.deletedAt,
      primaryImageUrl: row.primaryImageUrl,
      ratingAvg: row.ratingAvg,
      reviewCount: row.reviewCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };

  // Mirror the real repositories' innerJoin(categories): a product whose parent
  // category is absent must disappear from results, not appear with an empty label.
  const toProductCardRows = (rows: readonly ProductRow[]): ProductCardRow[] =>
    rows.flatMap((row) => (categoriesById.has(row.categoryId) ? [toProductCardRow(row)] : []));

  const assertMediaAttachments = (row: unknown): void => {
    if (env.SUPABASE_URL === undefined) return;
    for (const path of extractReferencedObjectPaths(collectMediaStrings(row))) {
      const upload = [...mediaUploadsById.values()].find(
        (u) => u.objectPath === path && u.bucket === env.SUPABASE_STORAGE_BUCKET,
      );
      if (
        !upload ||
        upload.verifiedAt === null ||
        upload.deletedAt !== null ||
        upload.deletingAt !== null
      )
        throw new ConflictError(
          'Complete and verify each media upload before attaching it',
          'MEDIA_NOT_VERIFIED',
        );
    }
  };

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
      (r) => r.productId === productId && r.isPublished && isRecordActive(r),
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
    findUserByIdWithCredentials(id: string): Promise<UserWithCredentials | null> {
      const found = usersById.get(id);
      return Promise.resolve(found !== undefined ? { ...found } : null);
    },

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
        address: user.address ?? null,
        displayName: user.displayName,
        role: user.role,
        isActive: true,
        tokenVersion: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
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
      if (existing.googleSub !== null && existing.googleSub !== googleSub)
        return Promise.reject(
          new ConflictError('Account is already linked', 'GOOGLE_SUB_MISMATCH'),
        );
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

    hasActivePasswordResetToken(tokenHash: string, now: Date): Promise<boolean> {
      for (const rt of resetTokensById.values()) {
        if (
          rt.tokenHash === tokenHash &&
          rt.usedAt === null &&
          rt.expiresAt.getTime() > now.getTime()
        ) {
          const user = usersById.get(rt.userId);
          if (user !== undefined && isRecordActive(user)) {
            return Promise.resolve(true);
          }
        }
      }
      return Promise.resolve(false);
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
      if (user === undefined || !isRecordActive(user)) {
        return Promise.resolve(false);
      }

      usersById.set(user.id, {
        ...user,
        passwordHash,
        tokenVersion: user.tokenVersion + 1,
        updatedAt: now,
      });

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

    updatePasswordAndRevokeSessions({ userId, passwordHash, now }): Promise<boolean> {
      const user = usersById.get(userId);
      if (user === undefined || !isRecordActive(user)) {
        return Promise.resolve(false);
      }
      usersById.set(userId, {
        ...user,
        passwordHash,
        tokenVersion: user.tokenVersion + 1,
        updatedAt: now,
      });
      for (const [id, tok] of tokensById.entries()) {
        if (tok.userId === userId && tok.revokedAt === null) {
          tokensById.set(id, { ...tok, revokedAt: now });
        }
      }
      for (const [id, rt] of resetTokensById.entries()) {
        if (rt.userId === userId && rt.usedAt === null) {
          resetTokensById.set(id, { ...rt, usedAt: now });
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

    createUser(input): Promise<UserEntity> {
      if (findStoredByEmail(input.email) !== null) {
        return Promise.reject(
          new ConflictError('An account with this email already exists', 'EMAIL_ALREADY_EXISTS'),
        );
      }
      const now = new Date();
      const stored: StoredUser = {
        id: input.id,
        email: input.email.trim().toLowerCase(),
        passwordHash: input.passwordHash,
        googleSub: null,
        phone: input.phone,
        address: input.address,
        displayName: input.displayName,
        role: input.role,
        isActive: input.isActive,
        tokenVersion: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: input.deletedAt,
      };
      usersById.set(stored.id, stored);
      return Promise.resolve(toPublicEntity(stored));
    },

    updateProfile(id, patch): Promise<UserEntity | null> {
      const existing = usersById.get(id);
      if (existing === undefined || !isRecordActive(existing)) {
        return Promise.resolve(null);
      }
      const updated: StoredUser = {
        ...existing,
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
        updatedAt: new Date(),
      };
      usersById.set(id, updated);
      return Promise.resolve(toPublicEntity(updated));
    },

    adminUpdateById(id, patch, now): Promise<UserEntity | null> {
      const existing = usersById.get(id);
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      if (patch.isActive === false || patch.role === 'user') {
        const activeAdmins = [...usersById.values()].filter(
          (u) => u.role === 'admin' && isRecordActive(u),
        );
        if (activeAdmins.length <= 1 && activeAdmins.some((u) => u.id === id)) {
          return Promise.reject(
            new ConflictError(
              'Cannot deactivate or demote the last active admin',
              'LAST_ADMIN_REQUIRED',
            ),
          );
        }
      }
      const nextEmail = patch.email !== undefined ? patch.email.trim().toLowerCase() : undefined;
      if (nextEmail !== undefined) {
        for (const other of usersById.values()) {
          if (other.id !== id && other.email === nextEmail) {
            return Promise.reject(
              new ConflictError(
                'An account with this email already exists',
                'EMAIL_ALREADY_EXISTS',
              ),
            );
          }
        }
      }
      const shouldRevoke =
        patch.isActive === false || patch.role !== undefined || nextEmail !== undefined;
      const updated: StoredUser = {
        ...existing,
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(nextEmail !== undefined ? { email: nextEmail, googleSub: null } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.deletedAt !== undefined ? { deletedAt: patch.deletedAt } : {}),
        ...(shouldRevoke ? { tokenVersion: existing.tokenVersion + 1 } : {}),
        updatedAt: now,
      };
      usersById.set(id, updated);
      if (shouldRevoke) {
        for (const [tokenId, tok] of tokensById.entries()) {
          if (tok.userId === id && tok.revokedAt === null) {
            tokensById.set(tokenId, { ...tok, revokedAt: now });
          }
        }
        for (const [rtId, rt] of resetTokensById.entries()) {
          if (rt.userId === id && rt.usedAt === null) {
            resetTokensById.set(rtId, { ...rt, usedAt: now });
          }
        }
      }
      return Promise.resolve(toPublicEntity(updated));
    },

    listCursor({
      limit,
      cursor,
      query,
      role,
      status,
      createdFrom,
      createdTo,
    }): Promise<readonly UserEntity[]> {
      const sorted = [...usersById.values()]
        .filter((item) => {
          if (role !== undefined && item.role !== role) return false;
          if (!matchesStatusFilter(item, status)) return false;
          if (!matchesDateRange(item.createdAt, createdFrom, createdTo)) return false;
          if (
            query !== undefined &&
            !matchesFuzzyInMemory([item.displayName, item.email, item.phone, item.address], query)
          ) {
            return false;
          }
          return true;
        })
        .sort(compareCreatedAtDesc);

      const filtered = applyDescCursor(sorted, cursor, (item) => item.createdAt);

      return Promise.resolve(filtered.slice(0, limit).map(toPublicEntity));
    },

    listOffset({ limit, offset, query, role, status, createdFrom, createdTo }) {
      const sorted = [...usersById.values()]
        .filter((item) => {
          if (role !== undefined && item.role !== role) return false;
          if (!matchesStatusFilter(item, status)) return false;
          if (!matchesDateRange(item.createdAt, createdFrom, createdTo)) return false;
          if (
            query !== undefined &&
            !matchesFuzzyInMemory([item.displayName, item.email, item.phone, item.address], query)
          ) {
            return false;
          }
          return true;
        })
        .sort(compareCreatedAtDesc);

      return Promise.resolve({
        items: sorted.slice(offset, offset + limit).map(toPublicEntity),
        total: sorted.length,
      });
    },
  };

  const sortCategories = (rows: CategoryRow[]): CategoryRow[] =>
    rows.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );

  const catalogRepo: CatalogRepository = {
    listActive(filter): Promise<readonly CategoryWithParentRow[]> {
      const active = [...categoriesById.values()].filter((row) => {
        if (!isRecordActive(row)) return false;
        if (filter?.parentId !== undefined && row.parentId !== filter.parentId) return false;
        if (filter?.parentId === undefined) {
          if (filter?.rootOnly === true && row.parentId !== null) return false;
          if (filter?.rootOnly === false && row.parentId === null) return false;
        }
        if (
          filter?.query !== undefined &&
          !matchesFuzzyInMemory([row.name, row.slug, row.description], filter.query)
        ) {
          return false;
        }
        return true;
      });
      return Promise.resolve(sortCategories(active).map(toCategoryWithParent));
    },

    listAdminCursor({
      limit,
      cursor,
      query,
      status,
      parentId,
      rootOnly,
    }): Promise<readonly CategoryWithParentRow[]> {
      const sorted = [...categoriesById.values()]
        .filter((row) => {
          if (!matchesStatusFilter(row, status)) return false;
          if (parentId !== undefined && row.parentId !== parentId) return false;
          if (parentId === undefined) {
            if (rootOnly === true && row.parentId !== null) return false;
            if (rootOnly === false && row.parentId === null) return false;
          }
          if (
            query !== undefined &&
            !matchesFuzzyInMemory([row.name, row.slug, row.description], query)
          ) {
            return false;
          }
          return true;
        })
        .sort(compareCreatedAtDesc);

      const filtered = applyDescCursor(sorted, cursor, (r) => r.createdAt);

      return Promise.resolve(filtered.slice(0, limit).map(toCategoryWithParent));
    },

    listAdminOffset({ limit, offset, query, status, parentId, rootOnly }) {
      const sorted = [...categoriesById.values()]
        .filter((row) => {
          if (!matchesStatusFilter(row, status)) return false;
          if (parentId !== undefined && row.parentId !== parentId) return false;
          if (parentId === undefined) {
            if (rootOnly === true && row.parentId !== null) return false;
            if (rootOnly === false && row.parentId === null) return false;
          }
          if (
            query !== undefined &&
            !matchesFuzzyInMemory([row.name, row.slug, row.description], query)
          ) {
            return false;
          }
          return true;
        })
        .sort(compareCreatedAtDesc);

      return Promise.resolve({
        items: sorted.slice(offset, offset + limit).map(toCategoryWithParent),
        total: sorted.length,
      });
    },

    findById(id: string): Promise<CategoryWithParentRow | null> {
      const found = categoriesById.get(id);
      return Promise.resolve(found !== undefined ? toCategoryWithParent(found) : null);
    },

    findByIds(ids: readonly string[]): Promise<readonly CategoryWithParentRow[]> {
      return Promise.resolve(
        ids.flatMap((id) => {
          const found = categoriesById.get(id);
          return found !== undefined ? [toCategoryWithParent(found)] : [];
        }),
      );
    },

    findActiveBySlug(slug: string): Promise<CategoryWithParentRow | null> {
      for (const row of categoriesById.values()) {
        if (row.slug === slug && isRecordActive(row)) {
          return Promise.resolve(toCategoryWithParent(row));
        }
      }
      return Promise.resolve(null);
    },

    listActiveChildren(parentId: string): Promise<readonly CategoryWithParentRow[]> {
      const children = [...categoriesById.values()].filter(
        (row) => row.parentId === parentId && isRecordActive(row),
      );
      return Promise.resolve(sortCategories(children).map(toCategoryWithParent));
    },

    hasNonDeletedChildren(parentId: string): Promise<boolean> {
      for (const row of categoriesById.values()) {
        if (row.parentId === parentId && isRecordActive(row)) {
          return Promise.resolve(true);
        }
      }
      return Promise.resolve(false);
    },

    hasAnyChildren(parentId: string): Promise<boolean> {
      for (const row of categoriesById.values()) {
        if (row.parentId === parentId) {
          return Promise.resolve(true);
        }
      }
      return Promise.resolve(false);
    },

    hasNonDeletedProducts(categoryId: string): Promise<boolean> {
      for (const row of productsById.values()) {
        if (row.categoryId === categoryId && isRecordActive(row)) {
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
        focusKeyword: input.focusKeyword,
        canonicalUrl: input.canonicalUrl,
        noIndex: input.noIndex,
        ogImageUrl: input.ogImageUrl,
        imageUrl: input.imageUrl,
        bannerImageUrl: input.bannerImageUrl,
        specSchema: [...input.specSchema],
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        createdAt: now,
        updatedAt: now,
        deletedAt: input.deletedAt ?? null,
      };
      assertMediaAttachments(created);
      categoriesById.set(created.id, created);
      return Promise.resolve(created);
    },

    updateById(id, patch): Promise<CategoryRow | null> {
      const existing = categoriesById.get(id);
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      const nextDeletedAt = patch.deletedAt !== undefined ? patch.deletedAt : existing.deletedAt;
      const nextSlug = patch.slug ?? existing.slug;
      if (nextDeletedAt === null) {
        for (const other of categoriesById.values()) {
          if (other.id !== id && other.deletedAt === null && other.slug === nextSlug) {
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
        ...(patch.focusKeyword !== undefined ? { focusKeyword: patch.focusKeyword } : {}),
        ...(patch.canonicalUrl !== undefined ? { canonicalUrl: patch.canonicalUrl } : {}),
        ...(patch.noIndex !== undefined ? { noIndex: patch.noIndex } : {}),
        ...(patch.ogImageUrl !== undefined ? { ogImageUrl: patch.ogImageUrl } : {}),
        ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl } : {}),
        ...(patch.bannerImageUrl !== undefined ? { bannerImageUrl: patch.bannerImageUrl } : {}),
        ...(patch.specSchema !== undefined ? { specSchema: [...patch.specSchema] } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.deletedAt !== undefined ? { deletedAt: patch.deletedAt } : {}),
        updatedAt: new Date(),
      };
      assertMediaAttachments(updated);
      categoriesById.set(id, updated);
      return Promise.resolve(updated);
    },

    softDeleteById(id, deletedAt): Promise<boolean> {
      const existing = categoriesById.get(id);
      if (existing === undefined) {
        return Promise.resolve(false);
      }
      categoriesById.set(id, { ...existing, isActive: false, deletedAt, updatedAt: deletedAt });
      return Promise.resolve(true);
    },

    listSitemapIndex() {
      const cats = [...categoriesById.values()]
        .filter((r) => isRecordActive(r) && !r.noIndex)
        .map((r) => ({ slug: r.slug, updatedAt: r.updatedAt }));
      const prods = [...productsById.values()]
        .filter((r) => isRecordActive(r) && !r.noIndex)
        .map((r) => ({ slug: r.slug, updatedAt: r.updatedAt }));
      const arts = [...articlesById.values()]
        .filter((r) => isRecordActive(r) && r.isPublished && !r.noIndex)
        .map((r) => ({ slug: r.slug, updatedAt: r.updatedAt }));
      return Promise.resolve({ categories: cats, products: prods, articles: arts });
    },
  };

  const sortProductsDesc = (rows: ProductRow[]): ProductRow[] => rows.sort(compareCreatedAtDesc);

  const productsRepo: ProductsRepository = {
    listPublicCursor(filter): Promise<readonly ProductCardRow[]> {
      const sort = filter.sort ?? 'newest';
      const matching = [...productsById.values()].filter((row) => {
        if (row.deletedAt !== null || !row.isActive) return false;
        if (filter.categoryIds !== undefined && !filter.categoryIds.includes(row.categoryId)) {
          return false;
        }
        if (
          filter.brandSlugs !== undefined &&
          filter.brandSlugs.length > 0 &&
          (row.brandSlug === null || !filter.brandSlugs.includes(row.brandSlug))
        ) {
          return false;
        }
        if (filter.isFeatured !== undefined && row.isFeatured !== filter.isFeatured) return false;
        if (filter.productType !== undefined && row.productType !== filter.productType) {
          return false;
        }
        if (filter.requiresQuote !== undefined && row.requiresQuote !== filter.requiresQuote) {
          return false;
        }
        if (filter.inStock === true && row.stock <= 0) return false;
        if (filter.inStock === false && row.stock !== 0) return false;
        if (filter.minRating !== undefined && Number(row.ratingAvg) < filter.minRating) {
          return false;
        }
        if (filter.minPrice !== undefined && row.priceIdr < filter.minPrice) return false;
        if (filter.maxPrice !== undefined && row.priceIdr > filter.maxPrice) return false;
        if (
          filter.specFilters !== undefined &&
          !filter.specFilters.every((sf) => matchesSpecFilter(row.specs, sf))
        ) {
          return false;
        }
        if (
          filter.query !== undefined &&
          !matchesFuzzyInMemory([row.name, row.sku, row.brandSlug, row.descriptionMd], filter.query)
        ) {
          return false;
        }
        return true;
      });

      const sorted =
        sort === 'price_asc'
          ? matching.sort((a, b) => a.priceIdr - b.priceIdr || a.id.localeCompare(b.id))
          : sort === 'price_desc'
            ? matching.sort((a, b) => b.priceIdr - a.priceIdr || b.id.localeCompare(a.id))
            : sort === 'rating_desc'
              ? matching.sort(
                  (a, b) =>
                    Number(b.ratingAvg) - Number(a.ratingAvg) ||
                    b.reviewCount - a.reviewCount ||
                    b.id.localeCompare(a.id),
                )
              : sortProductsDesc(matching);

      const cursor = filter.cursor;
      const afterCursor =
        cursor !== undefined
          ? sorted.filter((r) => {
              if (cursor.sort === 'newest') {
                const rMs = r.createdAt.getTime();
                const cMs = cursor.createdAt.getTime();
                return rMs < cMs || (rMs === cMs && r.id < cursor.id);
              }
              if (cursor.sort === 'price_asc') {
                return (
                  r.priceIdr > cursor.priceIdr ||
                  (r.priceIdr === cursor.priceIdr && r.id > cursor.id)
                );
              }
              if (cursor.sort === 'price_desc') {
                return (
                  r.priceIdr < cursor.priceIdr ||
                  (r.priceIdr === cursor.priceIdr && r.id < cursor.id)
                );
              }
              const rAvg = Number(r.ratingAvg);
              const cAvg = Number(cursor.ratingAvg);
              return (
                rAvg < cAvg ||
                (rAvg === cAvg && r.reviewCount < cursor.reviewCount) ||
                (rAvg === cAvg && r.reviewCount === cursor.reviewCount && r.id < cursor.id)
              );
            })
          : sorted;

      return Promise.resolve(toProductCardRows(afterCursor.slice(0, filter.limit)));
    },

    listAdminCursor({
      limit,
      cursor,
      query,
      status,
      categoryId,
      brandSlugs,
      productType,
      isFeatured,
      requiresQuote,
      inStock,
      createdFrom,
      createdTo,
    }): Promise<readonly ProductCardRow[]> {
      const sorted = sortProductsDesc(
        [...productsById.values()].filter((r) => {
          if (!matchesStatusFilter(r, status)) return false;
          if (!matchesDateRange(r.createdAt, createdFrom, createdTo)) return false;
          if (categoryId !== undefined && r.categoryId !== categoryId) return false;
          if (
            brandSlugs !== undefined &&
            brandSlugs.length > 0 &&
            (r.brandSlug === null || !brandSlugs.includes(r.brandSlug))
          ) {
            return false;
          }
          if (productType !== undefined && r.productType !== productType) return false;
          if (isFeatured !== undefined && r.isFeatured !== isFeatured) return false;
          if (requiresQuote !== undefined && r.requiresQuote !== requiresQuote) return false;
          if (inStock === true && r.stock <= 0) return false;
          if (inStock === false && r.stock !== 0) return false;
          if (
            query !== undefined &&
            !matchesFuzzyInMemory([r.name, r.sku, r.brandSlug, r.descriptionMd], query)
          ) {
            return false;
          }
          return true;
        }),
      );
      const filtered =
        cursor !== undefined
          ? sorted.filter((r) => {
              const rMs = r.createdAt.getTime();
              const cMs = cursor.createdAt.getTime();
              return rMs < cMs || (rMs === cMs && r.id < cursor.id);
            })
          : sorted;
      return Promise.resolve(toProductCardRows(filtered.slice(0, limit)));
    },

    listAdminOffset({
      limit,
      offset,
      query,
      status,
      categoryId,
      brandSlugs,
      productType,
      isFeatured,
      requiresQuote,
      inStock,
      createdFrom,
      createdTo,
    }) {
      const sorted = sortProductsDesc(
        [...productsById.values()].filter((r) => {
          if (!matchesStatusFilter(r, status)) return false;
          if (!matchesDateRange(r.createdAt, createdFrom, createdTo)) return false;
          if (categoryId !== undefined && r.categoryId !== categoryId) return false;
          if (
            brandSlugs !== undefined &&
            brandSlugs.length > 0 &&
            (r.brandSlug === null || !brandSlugs.includes(r.brandSlug))
          ) {
            return false;
          }
          if (productType !== undefined && r.productType !== productType) return false;
          if (isFeatured !== undefined && r.isFeatured !== isFeatured) return false;
          if (requiresQuote !== undefined && r.requiresQuote !== requiresQuote) return false;
          if (inStock === true && r.stock <= 0) return false;
          if (inStock === false && r.stock !== 0) return false;
          if (
            query !== undefined &&
            !matchesFuzzyInMemory([r.name, r.sku, r.brandSlug, r.descriptionMd], query)
          ) {
            return false;
          }
          return true;
        }),
      );
      const visible = toProductCardRows(sorted);
      return Promise.resolve({
        items: visible.slice(offset, offset + limit),
        total: visible.length,
      });
    },

    findActiveBySlug(slug): Promise<ProductRow | null> {
      for (const row of productsById.values()) {
        if (row.slug === slug && isRecordActive(row)) {
          return Promise.resolve(row);
        }
      }
      return Promise.resolve(null);
    },

    findById(id): Promise<ProductRow | null> {
      const row = productsById.get(id);
      return Promise.resolve(row ?? null);
    },

    findActiveByIds(ids): Promise<readonly ProductRow[]> {
      return Promise.resolve(
        ids.flatMap((id) => {
          const r = productsById.get(id);
          return r !== undefined && isRecordActive(r) ? [r] : [];
        }),
      );
    },

    findActiveBySlugs(slugs): Promise<readonly ProductRow[]> {
      const active = [...productsById.values()].filter((r) => isRecordActive(r));
      return Promise.resolve(active.filter((r) => slugs.includes(r.slug)));
    },

    findActiveCardsByIds(ids): Promise<readonly ProductCardRow[]> {
      return Promise.resolve(
        ids.flatMap((id) => {
          const r = productsById.get(id);
          return r !== undefined && isRecordActive(r) && categoriesById.has(r.categoryId)
            ? [toProductCardRow(r)]
            : [];
        }),
      );
    },

    listRecommendations({
      categoryId,
      categoryIds,
      excludeProductId,
      limit,
    }): Promise<readonly ProductCardRow[]> {
      const rows = [...productsById.values()]
        .filter((r) => {
          if (!isRecordActive(r)) return false;
          if (excludeProductId !== undefined && r.id === excludeProductId) return false;
          if (categoryIds !== undefined) {
            if (!categoryIds.includes(r.categoryId)) return false;
          } else if (categoryId !== undefined && r.categoryId !== categoryId) {
            return false;
          }
          return true;
        })
        .sort((a, b) => {
          if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1;
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
      return Promise.resolve(toProductCardRows(rows.slice(0, limit)));
    },

    listSparepartsCursor({
      parentProductId,
      limit,
      cursor,
      query,
    }): Promise<readonly ProductSparepartCardRow[]> {
      const links = sparepartsByParent.get(parentProductId) ?? [];
      const joined: ProductSparepartCardRow[] = [];
      for (const link of links) {
        const sp = productsById.get(link.sparepartProductId);
        if (sp !== undefined && isRecordActive(sp) && categoriesById.has(sp.categoryId)) {
          if (
            query !== undefined &&
            !matchesFuzzyInMemory([sp.name, sp.sku, sp.brandSlug, sp.descriptionMd], query)
          ) {
            continue;
          }
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
        focusKeyword: input.focusKeyword,
        canonicalUrl: input.canonicalUrl,
        noIndex: input.noIndex,
        ogImageUrl: input.ogImageUrl,
        priceIdr: input.priceIdr,
        requiresQuote: input.requiresQuote,
        stock: input.stock,
        isFeatured: input.isFeatured,
        isActive: input.isActive,
        primaryImageUrl: input.primaryImageUrl,
        media: [...input.media],
        specs: { ...input.specs },
        customSpecs: input.customSpecs.map((item) => ({ ...item })),
        lengthCm: input.lengthCm,
        widthCm: input.widthCm,
        heightCm: input.heightCm,
        weightKg: input.weightKg,
        ratingAvg: '0.00',
        reviewCount: 0,
        searchVector: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: input.deletedAt ?? null,
      };
      assertMediaAttachments(created);
      productsById.set(created.id, created);
      return Promise.resolve(created);
    },

    updateById(id, patch): Promise<ProductRow | null> {
      const existing = productsById.get(id);
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      const nextDeletedAt = patch.deletedAt !== undefined ? patch.deletedAt : existing.deletedAt;
      const nextSlug = patch.slug ?? existing.slug;
      const nextSku = patch.sku !== undefined ? patch.sku : existing.sku;
      if (nextDeletedAt === null) {
        for (const other of productsById.values()) {
          if (other.id === id || other.deletedAt !== null) continue;
          if (other.slug === nextSlug) {
            return Promise.reject(
              new ConflictError('A product with this slug already exists', 'SLUG_ALREADY_EXISTS'),
            );
          }
          if (nextSku !== null && other.sku === nextSku) {
            return Promise.reject(
              new ConflictError('A product with this SKU already exists', 'SKU_ALREADY_EXISTS'),
            );
          }
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
        ...(patch.focusKeyword !== undefined ? { focusKeyword: patch.focusKeyword } : {}),
        ...(patch.canonicalUrl !== undefined ? { canonicalUrl: patch.canonicalUrl } : {}),
        ...(patch.noIndex !== undefined ? { noIndex: patch.noIndex } : {}),
        ...(patch.ogImageUrl !== undefined ? { ogImageUrl: patch.ogImageUrl } : {}),
        ...(patch.priceIdr !== undefined ? { priceIdr: patch.priceIdr } : {}),
        ...(patch.requiresQuote !== undefined ? { requiresQuote: patch.requiresQuote } : {}),
        ...(patch.stock !== undefined ? { stock: patch.stock } : {}),
        ...(patch.isFeatured !== undefined ? { isFeatured: patch.isFeatured } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.deletedAt !== undefined ? { deletedAt: patch.deletedAt } : {}),
        ...(patch.primaryImageUrl !== undefined ? { primaryImageUrl: patch.primaryImageUrl } : {}),
        ...(patch.media !== undefined ? { media: [...patch.media] } : {}),
        ...(patch.specs !== undefined ? { specs: { ...patch.specs } } : {}),
        ...(patch.customSpecs !== undefined
          ? { customSpecs: patch.customSpecs.map((item) => ({ ...item })) }
          : {}),
        ...(patch.lengthCm !== undefined ? { lengthCm: patch.lengthCm } : {}),
        ...(patch.widthCm !== undefined ? { widthCm: patch.widthCm } : {}),
        ...(patch.heightCm !== undefined ? { heightCm: patch.heightCm } : {}),
        ...(patch.weightKg !== undefined ? { weightKg: patch.weightKg } : {}),
        updatedAt: new Date(),
      };
      assertMediaAttachments(updated);
      productsById.set(id, updated);
      return Promise.resolve(updated);
    },

    softDeleteById(id, deletedAt): Promise<boolean> {
      const existing = productsById.get(id);
      if (existing === undefined) {
        return Promise.resolve(false);
      }
      productsById.set(id, { ...existing, isActive: false, deletedAt, updatedAt: deletedAt });
      return Promise.resolve(true);
    },
  };

  const toReviewWithAuthor = (row: ProductReviewRow): ProductReviewWithAuthorRow => {
    const product = productsById.get(row.productId);
    return {
      id: row.id,
      productId: row.productId,
      productName: product?.name ?? '',
      productSlug: product?.slug ?? '',
      userId: row.userId,
      authorName: usersById.get(row.userId)?.displayName ?? 'Customer',
      orderId: row.orderId,
      rating: row.rating,
      comment: row.comment,
      isPublished: row.isPublished,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  };

  // Mirror innerJoin(products): reviews whose product is gone must not surface in lists.
  const toReviewWithAuthorRows = (
    rows: readonly ProductReviewRow[],
  ): ProductReviewWithAuthorRow[] =>
    rows.flatMap((row) => (productsById.has(row.productId) ? [toReviewWithAuthor(row)] : []));

  const reviewsRepo: ReviewsRepository = {
    listPublishedByProductCursor({ productId, limit, cursor, rating }) {
      const published = [...reviewsById.values()]
        .filter((r) => {
          if (r.productId !== productId || !r.isPublished || !isRecordActive(r)) return false;
          if (rating !== undefined && r.rating !== rating) return false;
          return true;
        })
        .sort(compareCreatedAtDesc);

      const filtered = applyDescCursor(published, cursor, (r) => r.createdAt);

      return Promise.resolve(toReviewWithAuthorRows(filtered.slice(0, limit)));
    },

    listAdminCursor({
      limit,
      cursor,
      productId,
      userId,
      isPublished,
      rating,
      query,
      status,
      createdFrom,
      createdTo,
    }) {
      const matched = [...reviewsById.values()]
        .filter((r) => {
          if (productId !== undefined && r.productId !== productId) return false;
          if (userId !== undefined && r.userId !== userId) return false;
          if (isPublished !== undefined && r.isPublished !== isPublished) return false;
          if (rating !== undefined && r.rating !== rating) return false;
          if (!matchesStatusFilter(r, status)) return false;
          if (!matchesDateRange(r.createdAt, createdFrom, createdTo)) return false;
          if (
            query !== undefined &&
            !matchesFuzzyInMemory([r.comment, usersById.get(r.userId)?.displayName ?? null], query)
          ) {
            return false;
          }
          return true;
        })
        .sort(compareCreatedAtDesc);

      const filtered = applyDescCursor(matched, cursor, (r) => r.createdAt);

      return Promise.resolve(toReviewWithAuthorRows(filtered.slice(0, limit)));
    },

    listAdminOffset({
      limit,
      offset,
      productId,
      userId,
      isPublished,
      rating,
      query,
      status,
      createdFrom,
      createdTo,
    }) {
      const matched = [...reviewsById.values()]
        .filter((r) => {
          if (productId !== undefined && r.productId !== productId) return false;
          if (userId !== undefined && r.userId !== userId) return false;
          if (isPublished !== undefined && r.isPublished !== isPublished) return false;
          if (rating !== undefined && r.rating !== rating) return false;
          if (!matchesStatusFilter(r, status)) return false;
          if (!matchesDateRange(r.createdAt, createdFrom, createdTo)) return false;
          if (
            query !== undefined &&
            !matchesFuzzyInMemory([r.comment, usersById.get(r.userId)?.displayName ?? null], query)
          ) {
            return false;
          }
          return true;
        })
        .sort(compareCreatedAtDesc);

      const visible = toReviewWithAuthorRows(matched);
      return Promise.resolve({
        items: visible.slice(offset, offset + limit),
        total: visible.length,
      });
    },

    createAndSyncProductRating(input) {
      const prod = productsById.get(input.productId);
      if (prod === undefined || !isRecordActive(prod)) {
        return Promise.reject(new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND'));
      }
      for (const existing of reviewsById.values()) {
        if (
          existing.productId === input.productId &&
          existing.userId === input.userId &&
          existing.deletedAt === null &&
          existing.orderId === input.orderId
        ) {
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
        isActive: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      reviewsById.set(created.id, created);
      recomputeProductRating(input.productId);
      return Promise.resolve(toReviewWithAuthor(created));
    },

    updateOwnReviewAndSyncRating({ productId, userId, rating, comment }) {
      const prod = productsById.get(productId);
      if (prod === undefined || !isRecordActive(prod)) {
        return Promise.reject(new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND'));
      }
      const existing = [...reviewsById.values()].find(
        (r) =>
          r.productId === productId &&
          r.userId === userId &&
          r.orderId === null &&
          isRecordActive(r),
      );
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      const updated: ProductReviewRow = {
        ...existing,
        ...(rating !== undefined ? { rating } : {}),
        ...(comment !== undefined ? { comment } : {}),
        updatedAt: new Date(),
      };
      reviewsById.set(existing.id, updated);
      recomputeProductRating(productId);
      return Promise.resolve(toReviewWithAuthor(updated));
    },

    softDeleteOwnReviewAndSyncRating({ productId, userId }) {
      const prod = productsById.get(productId);
      if (prod === undefined || !isRecordActive(prod)) {
        return Promise.reject(new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND'));
      }
      const existing = [...reviewsById.values()].find(
        (r) =>
          r.productId === productId &&
          r.userId === userId &&
          r.orderId === null &&
          isRecordActive(r),
      );
      if (existing === undefined) {
        return Promise.resolve(false);
      }
      const now = new Date();
      reviewsById.set(existing.id, {
        ...existing,
        isActive: false,
        isPublished: false,
        deletedAt: now,
        updatedAt: now,
      });
      recomputeProductRating(productId);
      return Promise.resolve(true);
    },

    updatePublishStateAndSyncRating(reviewId, patchOrIsPublished) {
      const existing = reviewsById.get(reviewId);
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      const patch =
        typeof patchOrIsPublished === 'boolean'
          ? { isPublished: patchOrIsPublished }
          : patchOrIsPublished;
      const now = new Date();
      const nextActive = patch.isActive !== undefined ? patch.isActive : existing.isActive;
      const nextDeletedAt =
        patch.isActive !== undefined
          ? patch.deletedAt !== undefined
            ? patch.deletedAt
            : patch.isActive
              ? null
              : (existing.deletedAt ?? now)
          : existing.deletedAt;

      if (nextDeletedAt === null) {
        for (const other of reviewsById.values()) {
          if (
            other.id !== reviewId &&
            other.productId === existing.productId &&
            other.userId === existing.userId &&
            other.orderId === existing.orderId &&
            other.deletedAt === null
          ) {
            return Promise.reject(
              new ConflictError(
                'An active review already exists for this user and product',
                'REVIEW_ALREADY_EXISTS',
              ),
            );
          }
        }
      }

      const nextPublished =
        patch.isActive === false && patch.isPublished === undefined
          ? false
          : (patch.isPublished ?? existing.isPublished);

      const updated: ProductReviewRow = {
        ...existing,
        isPublished: nextPublished,
        isActive: nextActive,
        deletedAt: nextDeletedAt,
        updatedAt: now,
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
      const now = new Date();
      reviewsById.set(reviewId, {
        ...existing,
        isActive: false,
        isPublished: false,
        deletedAt: existing.deletedAt ?? now,
        updatedAt: now,
      });
      recomputeProductRating(existing.productId);
      return Promise.resolve({ productId: existing.productId });
    },
  };

  const articlesRepo: ArticlesRepository = {
    listPublishedCursor({
      limit,
      cursor,
      tag,
      productId,
      query,
    }): Promise<readonly ArticleSummaryRow[]> {
      const published = [...articlesById.values()]
        .filter((r) => {
          if (!isRecordActive(r) || !r.isPublished) return false;
          if (tag !== undefined && !r.tags.includes(tag)) return false;
          if (productId !== undefined && !r.relatedProductIds.includes(productId)) return false;
          if (query !== undefined && !matchesFuzzyInMemory([r.title, r.slug, r.excerpt], query)) {
            return false;
          }
          return true;
        })
        .sort((a, b) => {
          const aTime = (a.publishedAt ?? a.createdAt).getTime();
          const bTime = (b.publishedAt ?? b.createdAt).getTime();
          if (bTime !== aTime) return bTime - aTime;
          return b.id.localeCompare(a.id);
        });

      const filtered = applyDescCursor(published, cursor, (r) => r.publishedAt ?? r.createdAt);

      return Promise.resolve(filtered.slice(0, limit).map(toArticleSummary));
    },

    listAdminCursor({
      limit,
      cursor,
      tag,
      isPublished,
      authorId,
      productId,
      query,
      status,
      createdFrom,
      createdTo,
    }): Promise<readonly ArticleSummaryRow[]> {
      const rows = [...articlesById.values()]
        .filter((r) => {
          if (!matchesStatusFilter(r, status)) return false;
          if (!matchesDateRange(r.createdAt, createdFrom, createdTo)) return false;
          if (isPublished !== undefined && r.isPublished !== isPublished) return false;
          if (authorId !== undefined && r.authorId !== authorId) return false;
          if (tag !== undefined && !r.tags.includes(tag)) return false;
          if (productId !== undefined && !r.relatedProductIds.includes(productId)) return false;
          if (query !== undefined && !matchesFuzzyInMemory([r.title, r.slug, r.excerpt], query)) {
            return false;
          }
          return true;
        })
        .sort(compareCreatedAtDesc);

      const filtered = applyDescCursor(rows, cursor, (r) => r.createdAt);

      return Promise.resolve(filtered.slice(0, limit).map(toArticleSummary));
    },

    listAdminOffset({
      limit,
      offset,
      tag,
      isPublished,
      authorId,
      productId,
      query,
      status,
      createdFrom,
      createdTo,
    }) {
      const rows = [...articlesById.values()]
        .filter((r) => {
          if (!matchesStatusFilter(r, status)) return false;
          if (!matchesDateRange(r.createdAt, createdFrom, createdTo)) return false;
          if (isPublished !== undefined && r.isPublished !== isPublished) return false;
          if (authorId !== undefined && r.authorId !== authorId) return false;
          if (tag !== undefined && !r.tags.includes(tag)) return false;
          if (productId !== undefined && !r.relatedProductIds.includes(productId)) return false;
          if (query !== undefined && !matchesFuzzyInMemory([r.title, r.slug, r.excerpt], query)) {
            return false;
          }
          return true;
        })
        .sort(compareCreatedAtDesc);

      return Promise.resolve({
        items: rows.slice(offset, offset + limit).map(toArticleSummary),
        total: rows.length,
      });
    },

    findPublishedBySlug(slug): Promise<ArticleDetailRow | null> {
      for (const row of articlesById.values()) {
        if (row.slug === slug && row.isPublished && isRecordActive(row)) {
          return Promise.resolve(toArticleDetail(row));
        }
      }
      return Promise.resolve(null);
    },

    findById(id): Promise<ArticleDetailRow | null> {
      const row = articlesById.get(id);
      return Promise.resolve(row !== undefined ? toArticleDetail(row) : null);
    },

    findRelatedPublished({ excludeId, tags, limit }): Promise<readonly ArticleSummaryRow[]> {
      const candidates = [...articlesById.values()].filter(
        (r) => r.id !== excludeId && r.isPublished && isRecordActive(r),
      );
      const tagMatches = candidates.filter((r) => r.tags.some((t) => tags.includes(t)));
      const rest = candidates.filter((r) => !tagMatches.includes(r));
      return Promise.resolve([...tagMatches, ...rest].slice(0, limit).map(toArticleSummary));
    },

    create(input): Promise<ArticleDetailRow> {
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
        focusKeyword: input.focusKeyword,
        canonicalUrl: input.canonicalUrl,
        noIndex: input.noIndex,
        ogImageUrl: input.ogImageUrl,
        tags: [...input.tags],
        relatedProductIds: [...input.relatedProductIds],
        isPublished: input.isPublished,
        isActive: input.isActive,
        publishedAt: input.publishedAt,
        createdAt: now,
        updatedAt: now,
        deletedAt: input.deletedAt ?? null,
      };
      assertMediaAttachments(created);
      articlesById.set(created.id, created);
      return Promise.resolve(toArticleDetail(created));
    },

    updateById(id, patch): Promise<ArticleDetailRow | null> {
      const existing = articlesById.get(id);
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      const nextDeletedAt = patch.deletedAt !== undefined ? patch.deletedAt : existing.deletedAt;
      const nextSlug = patch.slug ?? existing.slug;
      if (nextDeletedAt === null) {
        for (const other of articlesById.values()) {
          if (other.id !== id && other.deletedAt === null && other.slug === nextSlug) {
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
        ...(patch.focusKeyword !== undefined ? { focusKeyword: patch.focusKeyword } : {}),
        ...(patch.canonicalUrl !== undefined ? { canonicalUrl: patch.canonicalUrl } : {}),
        ...(patch.noIndex !== undefined ? { noIndex: patch.noIndex } : {}),
        ...(patch.ogImageUrl !== undefined ? { ogImageUrl: patch.ogImageUrl } : {}),
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
        ...(patch.relatedProductIds !== undefined
          ? { relatedProductIds: [...patch.relatedProductIds] }
          : {}),
        ...(patch.isPublished !== undefined ? { isPublished: patch.isPublished } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.deletedAt !== undefined ? { deletedAt: patch.deletedAt } : {}),
        ...(patch.publishedAt !== undefined ? { publishedAt: patch.publishedAt } : {}),
        updatedAt: new Date(),
      };
      assertMediaAttachments(updated);
      articlesById.set(id, updated);
      return Promise.resolve(toArticleDetail(updated));
    },

    softDeleteById(id, deletedAt): Promise<boolean> {
      const existing = articlesById.get(id);
      if (existing === undefined) {
        return Promise.resolve(false);
      }
      articlesById.set(id, { ...existing, isActive: false, deletedAt, updatedAt: deletedAt });
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
        expectedBytes: input.expectedBytes,
        verifiedAt: null,
        deletingAt: null,
        createdAt: new Date(),
        deletedAt: null,
      };
      mediaUploadsById.set(created.id, created);
      return Promise.resolve(created);
    },

    findById(id) {
      return Promise.resolve(mediaUploadsById.get(id) ?? null);
    },
    markVerified(id, verifiedAt) {
      const row = mediaUploadsById.get(id);
      if (!row || row.deletedAt !== null || row.deletingAt !== null) return Promise.resolve(null);
      const updated = { ...row, verifiedAt };
      mediaUploadsById.set(id, updated);
      return Promise.resolve(updated);
    },
    claimOrphans({ olderThan, limit }) {
      const referenced = new Set<string>();
      for (const row of [
        ...categoriesById.values(),
        ...productsById.values(),
        ...articlesById.values(),
      ]) {
        for (const path of extractReferencedObjectPaths(collectMediaStrings(row)))
          referenced.add(path);
      }
      const now = new Date();
      const staleLeaseCutoff = new Date(now.getTime() - 15 * 60 * 1_000);
      const rows = [...mediaUploadsById.values()]
        .filter(
          (r) =>
            r.deletedAt === null &&
            (r.deletingAt === null || r.deletingAt <= staleLeaseCutoff) &&
            r.createdAt <= olderThan &&
            !referenced.has(r.objectPath),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .slice(0, limit);
      for (const row of rows) mediaUploadsById.set(row.id, { ...row, deletingAt: now });
      return Promise.resolve(rows);
    },

    releaseOrphanClaims(ids): Promise<void> {
      for (const id of ids) {
        const existing = mediaUploadsById.get(id);
        if (existing !== undefined && existing.deletedAt === null) {
          mediaUploadsById.set(id, { ...existing, deletingAt: null });
        }
      }
      return Promise.resolve();
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
        address: params.address ?? null,
        displayName: params.displayName,
        role: params.role ?? 'user',
        isActive: true,
        tokenVersion: 1,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      };
      usersById.set(stored.id, stored);
      return toPublicEntity(stored);
    },
    seedMediaUpload(params): MediaUploadRow {
      const row: MediaUploadRow = {
        ...params,
        expectedBytes: null,
        verifiedAt: new Date(),
        deletingAt: null,
        deletedAt: null,
      };
      mediaUploadsById.set(row.id, row);
      return row;
    },
  };
}
