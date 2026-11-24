import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { users } from '@/db/schema/users.ts';
import type { DecodedCursor } from '@/lib/pagination.ts';
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

export interface UsersRepository {
  findById(id: string): Promise<UserEntity | null>;
  findByEmailWithCredentials(email: string): Promise<UserWithCredentials | null>;
  updateProfile(id: string, patch: UpdateUserProfilePatch): Promise<UserEntity | null>;
  listCursor(params: {
    readonly limit: number;
    readonly cursor?: DecodedCursor;
  }): Promise<readonly UserEntity[]>;
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
  const publicColumns = {
    id: users.id,
    email: users.email,
    phone: users.phone,
    displayName: users.displayName,
    role: users.role,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  };

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

    async listCursor({ limit, cursor }): Promise<readonly UserEntity[]> {
      const whereClause =
        cursor !== undefined
          ? or(
              lt(users.createdAt, cursor.createdAt),
              and(eq(users.createdAt, cursor.createdAt), lt(users.id, cursor.id)),
            )
          : undefined;

      const rows = await db
        .select(publicColumns)
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(limit);

      return rows.map(toUserEntity);
    },
  };
}
