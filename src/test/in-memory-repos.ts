import { ConflictError } from '@/lib/errors.ts';
import type {
  AuthRepository,
  NewRefreshTokenInput,
  RefreshTokenEntity,
  RefreshTokenWithUser,
} from '@/modules/auth/auth.repository.ts';
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
  seedUser(params: {
    readonly id: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly displayName: string;
    readonly role?: UserRole;
    readonly createdAt?: Date;
  }): UserEntity;
}

function toPublicEntity(stored: StoredUser): UserEntity {
  return {
    id: stored.id,
    email: stored.email,
    displayName: stored.displayName,
    role: stored.role,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

export function createInMemoryDatastore(): InMemoryDatastore {
  const usersById = new Map<string, StoredUser>();
  const tokensById = new Map<string, RefreshTokenEntity>();

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

  const authRepo: AuthRepository = {
    findUserByEmailWithCredentials(email: string): Promise<UserWithCredentials | null> {
      const found = findStoredByEmail(email);
      return Promise.resolve(found !== null ? { ...found } : null);
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
        displayName: user.displayName,
        role: user.role,
        createdAt: now,
        updatedAt: now,
      };
      usersById.set(stored.id, stored);
      insertToken(refreshToken);

      return Promise.resolve(toPublicEntity(stored));
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

    updateDisplayName(id: string, displayName: string): Promise<UserEntity | null> {
      const existing = usersById.get(id);
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      const updated: StoredUser = {
        ...existing,
        displayName,
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

  return {
    authRepo,
    usersRepo,
    seedUser(params): UserEntity {
      const createdAt = params.createdAt ?? new Date();
      const stored: StoredUser = {
        id: params.id,
        email: params.email.trim().toLowerCase(),
        passwordHash: params.passwordHash,
        displayName: params.displayName,
        role: params.role ?? 'user',
        createdAt,
        updatedAt: createdAt,
      };
      usersById.set(stored.id, stored);
      return toPublicEntity(stored);
    },
  };
}
