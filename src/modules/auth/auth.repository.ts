import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { mailOutbox, type NewMailDelivery } from '@/db/schema/mail-outbox.ts';
import { passwordResetTokens } from '@/db/schema/password-reset-tokens.ts';
import { refreshTokens } from '@/db/schema/refresh-tokens.ts';
import { users } from '@/db/schema/users.ts';
import { isUniqueViolation } from '@/lib/db-helpers.ts';
import { ConflictError } from '@/lib/errors.ts';
import type { UserEntity, UserWithCredentials } from '@/modules/users/users.repository.ts';
import type { UserRole } from '@/types/app.ts';

export interface NewUserInput {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly googleSub?: string | null;
  readonly phone?: string | null;
  readonly address?: string | null;
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
  findUserByIdWithCredentials(id: string): Promise<UserWithCredentials | null>;
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
  createPasswordResetToken(
    input: NewPasswordResetTokenInput,
    delivery?: NewMailDelivery,
  ): Promise<void>;
  hasActivePasswordResetToken(tokenHash: string, now: Date): Promise<boolean>;
  consumePasswordResetTokenAndUpdatePassword(params: {
    readonly tokenHash: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<boolean>;
  updatePasswordAndRevokeSessions(params: {
    readonly userId: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<boolean>;
}

function normalizeRole(rawRole: string): UserRole {
  return rawRole === 'admin' ? 'admin' : 'user';
}

export function createAuthRepository(db: Database): AuthRepository {
  const userPublicCols = {
    id: users.id,
    email: users.email,
    phone: users.phone,
    address: users.address,
    displayName: users.displayName,
    role: users.role,
    isActive: users.isActive,
    tokenVersion: users.tokenVersion,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
    deletedAt: users.deletedAt,
  };

  return {
    async findUserByIdWithCredentials(id: string): Promise<UserWithCredentials | null> {
      const [row] = await db
        .select({
          ...userPublicCols,
          passwordHash: users.passwordHash,
          googleSub: users.googleSub,
        })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);

      if (row === undefined) {
        return null;
      }

      return {
        id: row.id,
        email: row.email,
        phone: row.phone,
        address: row.address,
        displayName: row.displayName,
        role: normalizeRole(row.role),
        isActive: row.isActive,
        tokenVersion: row.tokenVersion,
        passwordHash: row.passwordHash,
        googleSub: row.googleSub,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
      };
    },

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
        address: row.address,
        displayName: row.displayName,
        role: normalizeRole(row.role),
        isActive: row.isActive,
        tokenVersion: row.tokenVersion,
        passwordHash: row.passwordHash,
        googleSub: row.googleSub,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
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
        address: row.address,
        displayName: row.displayName,
        role: normalizeRole(row.role),
        isActive: row.isActive,
        tokenVersion: row.tokenVersion,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
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
              address: user.address ?? null,
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
            address: created.address,
            displayName: created.displayName,
            role: normalizeRole(created.role),
            isActive: created.isActive,
            tokenVersion: created.tokenVersion,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
            deletedAt: created.deletedAt,
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
            .where(
              and(
                eq(users.id, userId),
                eq(users.isActive, true),
                isNull(users.deletedAt),
                or(isNull(users.googleSub), eq(users.googleSub, googleSub)),
              ),
            )
            .returning(userPublicCols);

          if (updated === undefined) {
            throw new ConflictError(
              'Account is already linked to another Google identity',
              'GOOGLE_SUB_MISMATCH',
            );
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
            address: updated.address,
            displayName: updated.displayName,
            role: normalizeRole(updated.role),
            isActive: updated.isActive,
            tokenVersion: updated.tokenVersion,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
            deletedAt: updated.deletedAt,
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
          address: row.user.address,
          displayName: row.user.displayName,
          role: normalizeRole(row.user.role),
          isActive: row.user.isActive,
          tokenVersion: row.user.tokenVersion,
          createdAt: row.user.createdAt,
          updatedAt: row.user.updatedAt,
          deletedAt: row.user.deletedAt,
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

    async createPasswordResetToken(
      input: NewPasswordResetTokenInput,
      delivery?: NewMailDelivery,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.insert(passwordResetTokens).values({
          id: input.id,
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        });
        if (delivery !== undefined) await tx.insert(mailOutbox).values(delivery);
      });
    },

    async hasActivePasswordResetToken(tokenHash: string, now: Date): Promise<boolean> {
      const [row] = await db
        .select({ id: passwordResetTokens.id })
        .from(passwordResetTokens)
        .innerJoin(users, eq(passwordResetTokens.userId, users.id))
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, now),
            eq(users.isActive, true),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
      return row !== undefined;
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

        const [updatedUser] = await tx
          .update(users)
          .set({
            passwordHash,
            tokenVersion: sql`${users.tokenVersion} + 1`,
            updatedAt: now,
          })
          .where(
            and(eq(users.id, consumed.userId), eq(users.isActive, true), isNull(users.deletedAt)),
          )
          .returning({ id: users.id });

        if (updatedUser === undefined) {
          return false;
        }

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

    async updatePasswordAndRevokeSessions({ userId, passwordHash, now }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(users)
          .set({
            passwordHash,
            tokenVersion: sql`${users.tokenVersion} + 1`,
            updatedAt: now,
          })
          .where(and(eq(users.id, userId), eq(users.isActive, true), isNull(users.deletedAt)))
          .returning({ id: users.id });

        if (updated === undefined) {
          return false;
        }

        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));

        await tx
          .update(passwordResetTokens)
          .set({ usedAt: now })
          .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));

        return true;
      });
    },
  };
}
