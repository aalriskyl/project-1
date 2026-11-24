import { and, eq, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import type { Database } from '@/db/client.ts';
import { refreshTokens } from '@/db/schema/refresh-tokens.ts';
import { users } from '@/db/schema/users.ts';
import { ConflictError } from '@/lib/errors.ts';
import type { UserEntity, UserWithCredentials } from '@/modules/users/users.repository.ts';
import type { UserRole } from '@/types/app.ts';

export interface NewUserInput {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly role: UserRole;
}

export interface NewRefreshTokenInput {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface RefreshTokenEntity {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly replacedByTokenId: string | null;
  readonly createdAt: Date;
}

export interface RefreshTokenWithUser {
  readonly token: RefreshTokenEntity;
  readonly user: UserEntity;
}

export interface AuthRepository {
  findUserByEmailWithCredentials(email: string): Promise<UserWithCredentials | null>;
  createUserWithRefreshToken(params: {
    readonly user: NewUserInput;
    readonly refreshToken: NewRefreshTokenInput;
  }): Promise<UserEntity>;
  insertRefreshToken(token: NewRefreshTokenInput): Promise<void>;
  findRefreshTokenWithUserByHash(tokenHash: string): Promise<RefreshTokenWithUser | null>;
  rotateRefreshToken(params: {
    readonly currentTokenId: string;
    readonly nextToken: NewRefreshTokenInput;
    readonly revokedAt: Date;
  }): Promise<boolean>;
  revokeTokenFamily(familyId: string, revokedAt: Date): Promise<void>;
  revokeTokenByHash(tokenHash: string, revokedAt: Date): Promise<void>;
}

function normalizeRole(rawRole: string): UserRole {
  return rawRole === 'admin' ? 'admin' : 'user';
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof postgres.PostgresError && err.code === '23505') {
    return true;
  }
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    return isUniqueViolation(err.cause);
  }
  return false;
}

export function createAuthRepository(db: Database): AuthRepository {
  return {
    async findUserByEmailWithCredentials(email: string): Promise<UserWithCredentials | null> {
      const normalized = email.trim().toLowerCase();
      const [row] = await db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          role: users.role,
          passwordHash: users.passwordHash,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.email, normalized))
        .limit(1);

      if (row === undefined) {
        return null;
      }

      return {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        role: normalizeRole(row.role),
        passwordHash: row.passwordHash,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async createUserWithRefreshToken({ user, refreshToken }): Promise<UserEntity> {
      try {
        return await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(users)
            .values({
              id: user.id,
              email: user.email,
              passwordHash: user.passwordHash,
              displayName: user.displayName,
              role: user.role,
            })
            .returning({
              id: users.id,
              email: users.email,
              displayName: users.displayName,
              role: users.role,
              createdAt: users.createdAt,
              updatedAt: users.updatedAt,
            });

          if (created === undefined) {
            throw new Error('Failed to insert user row');
          }

          await tx.insert(refreshTokens).values({
            id: refreshToken.id,
            userId: refreshToken.userId,
            familyId: refreshToken.familyId,
            tokenHash: refreshToken.tokenHash,
            expiresAt: refreshToken.expiresAt,
          });

          return {
            id: created.id,
            email: created.email,
            displayName: created.displayName,
            role: normalizeRole(created.role),
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
          };
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            'An account with this email already exists',
            'EMAIL_ALREADY_EXISTS',
          );
        }
        throw err;
      }
    },

    async insertRefreshToken(token: NewRefreshTokenInput): Promise<void> {
      await db.insert(refreshTokens).values({
        id: token.id,
        userId: token.userId,
        familyId: token.familyId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
      });
    },

    async findRefreshTokenWithUserByHash(tokenHash: string): Promise<RefreshTokenWithUser | null> {
      const [row] = await db
        .select({
          token: {
            id: refreshTokens.id,
            userId: refreshTokens.userId,
            familyId: refreshTokens.familyId,
            tokenHash: refreshTokens.tokenHash,
            expiresAt: refreshTokens.expiresAt,
            revokedAt: refreshTokens.revokedAt,
            replacedByTokenId: refreshTokens.replacedByTokenId,
            createdAt: refreshTokens.createdAt,
          },
          user: {
            id: users.id,
            email: users.email,
            displayName: users.displayName,
            role: users.role,
            createdAt: users.createdAt,
            updatedAt: users.updatedAt,
          },
        })
        .from(refreshTokens)
        .innerJoin(users, eq(refreshTokens.userId, users.id))
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);

      if (row === undefined) {
        return null;
      }

      return {
        token: row.token,
        user: {
          id: row.user.id,
          email: row.user.email,
          displayName: row.user.displayName,
          role: normalizeRole(row.user.role),
          createdAt: row.user.createdAt,
          updatedAt: row.user.updatedAt,
        },
      };
    },

    async rotateRefreshToken({ currentTokenId, nextToken, revokedAt }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [revoked] = await tx
          .update(refreshTokens)
          .set({
            revokedAt,
            replacedByTokenId: nextToken.id,
          })
          .where(and(eq(refreshTokens.id, currentTokenId), isNull(refreshTokens.revokedAt)))
          .returning({ id: refreshTokens.id });

        if (revoked === undefined) {
          return false;
        }

        await tx.insert(refreshTokens).values({
          id: nextToken.id,
          userId: nextToken.userId,
          familyId: nextToken.familyId,
          tokenHash: nextToken.tokenHash,
          expiresAt: nextToken.expiresAt,
        });

        return true;
      });
    },

    async revokeTokenFamily(familyId: string, revokedAt: Date): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt })
        .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
    },

    async revokeTokenByHash(tokenHash: string, revokedAt: Date): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt })
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
    },
  };
}
