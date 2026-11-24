import { and, eq, gt, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import type { Database } from '@/db/client.ts';
import { passwordResetTokens } from '@/db/schema/password-reset-tokens.ts';
import { refreshTokens } from '@/db/schema/refresh-tokens.ts';
import { users } from '@/db/schema/users.ts';
import { ConflictError } from '@/lib/errors.ts';
import type { UserEntity, UserWithCredentials } from '@/modules/users/users.repository.ts';
import type { UserRole } from '@/types/app.ts';

export interface NewUserInput {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly googleSub?: string | null;
  readonly phone?: string | null;
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

export interface NewPasswordResetTokenInput {
  readonly id: string;
  readonly userId: string;
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
  findUserByGoogleSub(googleSub: string): Promise<UserEntity | null>;
  createUserWithRefreshToken(params: {
    readonly user: NewUserInput;
    readonly refreshToken: NewRefreshTokenInput;
  }): Promise<UserEntity>;
  linkGoogleSubAndInsertRefreshToken(params: {
    readonly userId: string;
    readonly googleSub: string;
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
  createPasswordResetToken(input: NewPasswordResetTokenInput): Promise<void>;
  consumePasswordResetTokenAndUpdatePassword(params: {
    readonly tokenHash: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<boolean>;
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
  const userPublicCols = {
    id: users.id,
    email: users.email,
    phone: users.phone,
    displayName: users.displayName,
    role: users.role,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  };

  return {
    async findUserByEmailWithCredentials(email: string): Promise<UserWithCredentials | null> {
      const normalized = email.trim().toLowerCase();
      const [row] = await db
        .select({
          ...userPublicCols,
          passwordHash: users.passwordHash,
          googleSub: users.googleSub,
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
        phone: row.phone,
        displayName: row.displayName,
        role: normalizeRole(row.role),
        passwordHash: row.passwordHash,
        googleSub: row.googleSub,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async findUserByGoogleSub(googleSub: string): Promise<UserEntity | null> {
      const [row] = await db
        .select(userPublicCols)
        .from(users)
        .where(eq(users.googleSub, googleSub))
        .limit(1);

      if (row === undefined) {
        return null;
      }

      return {
        id: row.id,
        email: row.email,
        phone: row.phone,
        displayName: row.displayName,
        role: normalizeRole(row.role),
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
              googleSub: user.googleSub ?? null,
              phone: user.phone ?? null,
              displayName: user.displayName,
              role: user.role,
            })
            .returning(userPublicCols);

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
            phone: created.phone,
            displayName: created.displayName,
            role: normalizeRole(created.role),
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
          };
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            'An account with this email or Google identity already exists',
            'EMAIL_ALREADY_EXISTS',
          );
        }
        throw err;
      }
    },

    async linkGoogleSubAndInsertRefreshToken({
      userId,
      googleSub,
      refreshToken,
    }): Promise<UserEntity> {
      try {
        return await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(users)
            .set({ googleSub, updatedAt: new Date() })
            .where(eq(users.id, userId))
            .returning(userPublicCols);

          if (updated === undefined) {
            throw new Error('User not found when linking Google account');
          }

          await tx.insert(refreshTokens).values({
            id: refreshToken.id,
            userId: refreshToken.userId,
            familyId: refreshToken.familyId,
            tokenHash: refreshToken.tokenHash,
            expiresAt: refreshToken.expiresAt,
          });

          return {
            id: updated.id,
            email: updated.email,
            phone: updated.phone,
            displayName: updated.displayName,
            role: normalizeRole(updated.role),
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
          };
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            'Google account is already linked to another user',
            'GOOGLE_ALREADY_LINKED',
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
          user: userPublicCols,
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
          phone: row.user.phone,
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

    async createPasswordResetToken(input: NewPasswordResetTokenInput): Promise<void> {
      await db.insert(passwordResetTokens).values({
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      });
    },

    async consumePasswordResetTokenAndUpdatePassword({
      tokenHash,
      passwordHash,
      now,
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [consumed] = await tx
          .update(passwordResetTokens)
          .set({ usedAt: now })
          .where(
            and(
              eq(passwordResetTokens.tokenHash, tokenHash),
              isNull(passwordResetTokens.usedAt),
              gt(passwordResetTokens.expiresAt, now),
            ),
          )
          .returning({ userId: passwordResetTokens.userId });

        if (consumed === undefined) {
          return false;
        }

        await tx
          .update(users)
          .set({ passwordHash, updatedAt: now })
          .where(eq(users.id, consumed.userId));

        // Revoke all active sessions and any remaining unused reset tokens for this user.
        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(and(eq(refreshTokens.userId, consumed.userId), isNull(refreshTokens.revokedAt)));

        await tx
          .update(passwordResetTokens)
          .set({ usedAt: now })
          .where(
            and(
              eq(passwordResetTokens.userId, consumed.userId),
              isNull(passwordResetTokens.usedAt),
            ),
          );

        return true;
      });
    },
  };
}
