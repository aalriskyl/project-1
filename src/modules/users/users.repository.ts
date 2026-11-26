import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { refreshTokens } from '@/db/schema/refresh-tokens.ts';
import { users } from '@/db/schema/users.ts';
import {
  buildDateRangeConditions,
  buildDescCursorCondition,
  buildStatusFilterConditions,
  isUniqueViolation,
} from '@/lib/db-helpers.ts';
import { ConflictError } from '@/lib/errors.ts';
import { buildFuzzySearchCondition } from '@/lib/search.ts';
import type { UserRole } from '@/types/app.ts';
import type {
  AdminDateListFilter,
  CursorListParams,
  OffsetListParams,
  OffsetListResult,
  SoftDeletableEntity,
  SoftDeletePatch,
} from '@/types/common.ts';

export interface UserEntity extends SoftDeletableEntity {
  readonly email: string;
  readonly phone: string | null;
  readonly address: string | null;
  readonly displayName: string;
  readonly role: UserRole;
}

export interface UserWithCredentials extends UserEntity {
  readonly passwordHash: string | null;
  readonly googleSub: string | null;
}

export interface UpdateUserProfilePatch {
  readonly displayName?: string;
  readonly phone?: string | null;
  readonly address?: string | null;
}

export interface AdminCreateUserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly address: string | null;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly deletedAt: Date | null;
}

export interface AdminUpdateUserPatch extends UpdateUserProfilePatch, SoftDeletePatch {
  readonly email?: string;
  readonly role?: UserRole;
}

export interface UsersListFilter extends AdminDateListFilter {
  readonly role?: UserRole;
}

export interface UsersRepository {
  findById(id: string): Promise<UserEntity | null>;
  findByEmailWithCredentials(email: string): Promise<UserWithCredentials | null>;
  createUser(input: AdminCreateUserRecord): Promise<UserEntity>;
  updateProfile(id: string, patch: UpdateUserProfilePatch): Promise<UserEntity | null>;
  adminUpdateById(id: string, patch: AdminUpdateUserPatch, now: Date): Promise<UserEntity | null>;
  listCursor(params: UsersListFilter & CursorListParams): Promise<readonly UserEntity[]>;
  listOffset(params: UsersListFilter & OffsetListParams): Promise<OffsetListResult<UserEntity>>;
}

function normalizeRole(rawRole: string): UserRole {
  return rawRole === 'admin' ? 'admin' : 'user';
}

function toUserEntity(row: {
  id: string;
  email: string;
  phone: string | null;
  address: string | null;
  displayName: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): UserEntity {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    address: row.address,
    displayName: row.displayName,
    role: normalizeRole(row.role),
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function createUsersRepository(db: Database): UsersRepository {
  const userSearchTarget = sql`(${users.displayName} || ' ' || ${users.email} || ' ' || coalesce(${users.phone}, '') || ' ' || coalesce(${users.address}, ''))`;

  const publicColumns = {
    id: users.id,
    email: users.email,
    phone: users.phone,
    address: users.address,
    displayName: users.displayName,
    role: users.role,
    isActive: users.isActive,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
    deletedAt: users.deletedAt,
  };

  function buildFilterConditions(filter: UsersListFilter): SQL[] {
    const conditions: SQL[] = [
      ...buildStatusFilterConditions(users, filter.status),
      ...buildDateRangeConditions(users.createdAt, filter),
    ];
    if (filter.role !== undefined) {
      conditions.push(eq(users.role, filter.role));
    }
    if (filter.query !== undefined) {
      conditions.push(
        buildFuzzySearchCondition({ targetSql: userSearchTarget, query: filter.query }),
      );
    }
    return conditions;
  }

  return {
    async findById(id: string): Promise<UserEntity | null> {
      const [row] = await db.select(publicColumns).from(users).where(eq(users.id, id)).limit(1);
      return row !== undefined ? toUserEntity(row) : null;
    },

    async findByEmailWithCredentials(email: string): Promise<UserWithCredentials | null> {
      const normalizedEmail = email.trim().toLowerCase();
      const [row] = await db
        .select({
          ...publicColumns,
          passwordHash: users.passwordHash,
          googleSub: users.googleSub,
        })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      if (row === undefined) {
        return null;
      }

      return {
        ...toUserEntity(row),
        passwordHash: row.passwordHash,
        googleSub: row.googleSub,
      };
    },

    async createUser(input: AdminCreateUserRecord): Promise<UserEntity> {
      try {
        const [created] = await db
          .insert(users)
          .values({
            id: input.id,
            email: input.email.trim().toLowerCase(),
            passwordHash: input.passwordHash,
            displayName: input.displayName,
            phone: input.phone,
            address: input.address,
            role: input.role,
            isActive: input.isActive,
            deletedAt: input.deletedAt,
          })
          .returning(publicColumns);

        if (created === undefined) {
          throw new Error('Failed to insert user');
        }
        return toUserEntity(created);
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

    async updateProfile(id: string, patch: UpdateUserProfilePatch): Promise<UserEntity | null> {
      const [updated] = await db
        .update(users)
        .set({
          ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
          ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
          ...(patch.address !== undefined ? { address: patch.address } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, id), eq(users.isActive, true), isNull(users.deletedAt)))
        .returning(publicColumns);

      return updated !== undefined ? toUserEntity(updated) : null;
    },

    async adminUpdateById(id, patch, now): Promise<UserEntity | null> {
      try {
        return await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(users)
            .set({
              ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
              ...(patch.email !== undefined ? { email: patch.email.trim().toLowerCase() } : {}),
              ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
              ...(patch.address !== undefined ? { address: patch.address } : {}),
              ...(patch.role !== undefined ? { role: patch.role } : {}),
              ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
              ...(patch.deletedAt !== undefined ? { deletedAt: patch.deletedAt } : {}),
              updatedAt: now,
            })
            .where(eq(users.id, id))
            .returning(publicColumns);

          if (updated === undefined) {
            return null;
          }

          if (patch.isActive === false || patch.role !== undefined) {
            await tx
              .update(refreshTokens)
              .set({ revokedAt: now })
              .where(and(eq(refreshTokens.userId, id), isNull(refreshTokens.revokedAt)));
          }

          return toUserEntity(updated);
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

    async listCursor({
      limit,
      cursor,
      query,
      role,
      status,
      createdFrom,
      createdTo,
    }): Promise<readonly UserEntity[]> {
      const conditions = buildFilterConditions({
        ...(query !== undefined ? { query } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(createdFrom !== undefined ? { createdFrom } : {}),
        ...(createdTo !== undefined ? { createdTo } : {}),
      });
      const cursorCond = buildDescCursorCondition(users.createdAt, users.id, cursor);
      if (cursorCond !== undefined) {
        conditions.push(cursorCond);
      }

      const rows = await db
        .select(publicColumns)
        .from(users)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(limit);

      return rows.map(toUserEntity);
    },

    async listOffset({ limit, offset, query, role, status, createdFrom, createdTo }) {
      const conditions = buildFilterConditions({
        ...(query !== undefined ? { query } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(createdFrom !== undefined ? { createdFrom } : {}),
        ...(createdTo !== undefined ? { createdTo } : {}),
      });
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, countRows] = await Promise.all([
        db
          .select(publicColumns)
          .from(users)
          .where(whereClause)
          .orderBy(desc(users.createdAt), desc(users.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(users)
          .where(whereClause),
      ]);

      return {
        items: rows.map(toUserEntity),
        total: countRows[0]?.total ?? 0,
      };
    },
  };
}
