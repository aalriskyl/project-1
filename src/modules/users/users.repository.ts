import { and, desc, eq, lt, or, type SQL, sql } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { users } from '@/db/schema/users.ts';
import type { DecodedCursor } from '@/lib/pagination.ts';
import { buildFuzzySearchCondition } from '@/lib/search.ts';
import type { UserRole } from '@/types/app.ts';

export interface UserEntity {
  readonly id: string;
  readonly email: string;
  readonly phone: string | null;
  readonly displayName: string;
  readonly role: UserRole;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UserWithCredentials extends UserEntity {
  readonly passwordHash: string | null;
  readonly googleSub: string | null;
}

export interface UpdateUserProfilePatch {
  readonly displayName?: string;
  readonly phone?: string | null;
}

export interface UsersListFilter {
  readonly query?: string;
  readonly role?: UserRole;
}

export interface UsersRepository {
  findById(id: string): Promise<UserEntity | null>;
  findByEmailWithCredentials(email: string): Promise<UserWithCredentials | null>;
  updateProfile(id: string, patch: UpdateUserProfilePatch): Promise<UserEntity | null>;
  listCursor(params: {
    readonly limit: number;
    readonly cursor?: DecodedCursor;
    readonly query?: string;
    readonly role?: UserRole;
  }): Promise<readonly UserEntity[]>;
  listOffset(params: {
    readonly limit: number;
    readonly offset: number;
    readonly query?: string;
    readonly role?: UserRole;
  }): Promise<{ readonly items: readonly UserEntity[]; readonly total: number }>;
}

function normalizeRole(rawRole: string): UserRole {
  return rawRole === 'admin' ? 'admin' : 'user';
}

function toUserEntity(row: {
  id: string;
  email: string;
  phone: string | null;
  displayName: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}): UserEntity {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    displayName: row.displayName,
    role: normalizeRole(row.role),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createUsersRepository(db: Database): UsersRepository {
  const userSearchTarget = sql`(${users.displayName} || ' ' || ${users.email} || ' ' || coalesce(${users.phone}, ''))`;

  const publicColumns = {
    id: users.id,
    email: users.email,
    phone: users.phone,
    displayName: users.displayName,
    role: users.role,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  };

  function buildFilterConditions(filter: UsersListFilter): SQL[] {
    const conditions: SQL[] = [];
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

    async updateProfile(id: string, patch: UpdateUserProfilePatch): Promise<UserEntity | null> {
      const [updated] = await db
        .update(users)
        .set({
          ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
          ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, id))
        .returning(publicColumns);

      return updated !== undefined ? toUserEntity(updated) : null;
    },

    async listCursor({ limit, cursor, query, role }): Promise<readonly UserEntity[]> {
      const conditions = buildFilterConditions({
        ...(query !== undefined ? { query } : {}),
        ...(role !== undefined ? { role } : {}),
      });
      if (cursor !== undefined) {
        const cursorCond = or(
          lt(users.createdAt, cursor.createdAt),
          and(eq(users.createdAt, cursor.createdAt), lt(users.id, cursor.id)),
        );
        if (cursorCond !== undefined) {
          conditions.push(cursorCond);
        }
      }

      const rows = await db
        .select(publicColumns)
        .from(users)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(limit);

      return rows.map(toUserEntity);
    },

    async listOffset({ limit, offset, query, role }) {
      const conditions = buildFilterConditions({
        ...(query !== undefined ? { query } : {}),
        ...(role !== undefined ? { role } : {}),
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
