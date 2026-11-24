import { ForbiddenError, NotFoundError } from '@/lib/errors.ts';
import { type CursorPage, decodeCursor, encodeCursor } from '@/lib/pagination.ts';
import type { UserEntity, UsersRepository } from '@/modules/users/users.repository.ts';
import type { ListUsersQuery, PublicUser, UpdateMeBody } from '@/modules/users/users.schema.ts';
import type { AuthUser } from '@/types/app.ts';

export interface UsersService {
  getMe(actor: AuthUser): Promise<PublicUser>;
  updateMe(actor: AuthUser, input: UpdateMeBody): Promise<PublicUser>;
  getUserById(actor: AuthUser, targetUserId: string): Promise<PublicUser>;
  listUsers(actor: AuthUser, query: ListUsersQuery): Promise<CursorPage<PublicUser>>;
}

export function serializeUser(entity: UserEntity): PublicUser {
  return {
    id: entity.id,
    email: entity.email,
    displayName: entity.displayName,
    role: entity.role,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

export function createUsersService(usersRepo: UsersRepository): UsersService {
  return {
    async getMe(actor: AuthUser): Promise<PublicUser> {
      const user = await usersRepo.findById(actor.id);
      if (user === null) {
        throw new NotFoundError('User not found', 'USER_NOT_FOUND');
      }
      return serializeUser(user);
    },

    async updateMe(actor: AuthUser, input: UpdateMeBody): Promise<PublicUser> {
      const updated = await usersRepo.updateDisplayName(actor.id, input.displayName);
      if (updated === null) {
        throw new NotFoundError('User not found', 'USER_NOT_FOUND');
      }
      return serializeUser(updated);
    },

    async getUserById(actor: AuthUser, targetUserId: string): Promise<PublicUser> {
      // Explicit server-side resource ownership check to prevent IDOR.
      if (actor.id !== targetUserId && actor.role !== 'admin') {
        throw new ForbiddenError('You can only access your own user record', 'USER_FORBIDDEN');
      }

      const user = await usersRepo.findById(targetUserId);
      if (user === null) {
        throw new NotFoundError('User not found', 'USER_NOT_FOUND');
      }
      return serializeUser(user);
    },

    async listUsers(actor: AuthUser, query: ListUsersQuery): Promise<CursorPage<PublicUser>> {
      if (actor.role !== 'admin') {
        throw new ForbiddenError('Admin privileges required to list users', 'USER_FORBIDDEN');
      }

      const decodedCursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;
      const rows = await usersRepo.listCursor({
        limit: query.limit + 1,
        ...(decodedCursor !== undefined ? { cursor: decodedCursor } : {}),
      });

      const hasMore = rows.length > query.limit;
      const pageItems = hasMore ? rows.slice(0, query.limit) : rows;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor = hasMore && lastItem !== undefined ? encodeCursor(lastItem) : null;

      return {
        data: pageItems.map(serializeUser),
        meta: {
          nextCursor,
          hasMore,
          limit: query.limit,
        },
      };
    },
  };
}
