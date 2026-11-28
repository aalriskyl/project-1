import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/shared/errors.ts';
import { generateId } from '@/lib/auth/id.ts';
import { type CursorPage, paginateAdminList } from '@/lib/api/pagination.ts';
import { hashPassword } from '@/lib/auth/password.ts';
import { isRecordActive, resolveActiveStateInput, toRecordStatus } from '@/lib/api/status.ts';
import type { ActiveSessionUserState } from '@/middlewares/auth/auth.ts';
import { assertAdminUser } from '@/middlewares/auth/authorize.ts';
import type { UserEntity, UsersRepository } from '@/modules/users/users.repository.ts';
import type {
  CreateAdminUserBody,
  ListUsersQuery,
  PublicUser,
  UpdateMeBody,
  UpdateUserStatusBody,
} from '@/modules/users/users.schema.ts';
import type { AuthUser } from '@/types/app.ts';

export interface UsersService {
  resolveAuthUser(userId: string): Promise<ActiveSessionUserState | null>;
  getMe(actor: AuthUser): Promise<PublicUser>;
  updateMe(actor: AuthUser, input: UpdateMeBody): Promise<PublicUser>;
  getUserById(actor: AuthUser, targetUserId: string): Promise<PublicUser>;
  listUsers(actor: AuthUser, query: ListUsersQuery): Promise<CursorPage<PublicUser>>;
  createUser(actor: AuthUser, input: CreateAdminUserBody): Promise<PublicUser>;
  updateUserStatus(
    actor: AuthUser,
    targetUserId: string,
    input: UpdateUserStatusBody,
  ): Promise<PublicUser>;
  deleteUser(actor: AuthUser, targetUserId: string): Promise<void>;
}

export function serializeUser(entity: UserEntity): PublicUser {
  return {
    id: entity.id,
    email: entity.email,
    name: entity.displayName,
    displayName: entity.displayName,
    phone: entity.phone,
    address: entity.address,
    role: entity.role,
    isActive: isRecordActive(entity),
    status: toRecordStatus(entity),
    deletedAt: entity.deletedAt !== null ? entity.deletedAt.toISOString() : null,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

export function createUsersService(usersRepo: UsersRepository): UsersService {
  return {
    async resolveAuthUser(userId: string): Promise<ActiveSessionUserState | null> {
      const user = await usersRepo.findById(userId);
      if (user === null) {
        return null;
      }
      return {
        id: user.id,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        deletedAt: user.deletedAt,
        tokenVersion: user.tokenVersion,
      };
    },

    async getMe(actor: AuthUser): Promise<PublicUser> {
      const user = await usersRepo.findById(actor.id);
      if (user === null) {
        throw new NotFoundError('User not found', 'USER_NOT_FOUND');
      }
      if (!isRecordActive(user)) {
        throw new ForbiddenError('This account has been deactivated', 'ACCOUNT_INACTIVE');
      }
      return serializeUser(user);
    },

    async updateMe(actor: AuthUser, input: UpdateMeBody): Promise<PublicUser> {
      const existing = await usersRepo.findById(actor.id);
      if (existing === null) {
        throw new NotFoundError('User not found', 'USER_NOT_FOUND');
      }
      if (!isRecordActive(existing)) {
        throw new ForbiddenError('This account has been deactivated', 'ACCOUNT_INACTIVE');
      }

      const nextName = input.name ?? input.displayName;
      const updated = await usersRepo.updateProfile(actor.id, {
        ...(nextName !== undefined ? { displayName: nextName } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
      });
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
      if (actor.role !== 'admin' && !isRecordActive(user)) {
        throw new ForbiddenError('This account has been deactivated', 'ACCOUNT_INACTIVE');
      }
      return serializeUser(user);
    },

    async listUsers(actor: AuthUser, query: ListUsersQuery): Promise<CursorPage<PublicUser>> {
      if (actor.role !== 'admin') {
        throw new ForbiddenError('Admin privileges required to list users', 'USER_FORBIDDEN');
      }

      const filters = {
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(query.role !== undefined ? { role: query.role } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.createdFrom !== undefined ? { createdFrom: query.createdFrom } : {}),
        ...(query.createdTo !== undefined ? { createdTo: query.createdTo } : {}),
      };

      return paginateAdminList({
        query,
        listOffset: ({ limit, offset }) => usersRepo.listOffset({ limit, offset, ...filters }),
        listCursor: ({ limit, cursor }) =>
          usersRepo.listCursor({ limit, ...(cursor !== undefined ? { cursor } : {}), ...filters }),
        serialize: serializeUser,
      });
    },

    async createUser(actor: AuthUser, input: CreateAdminUserBody): Promise<PublicUser> {
      assertAdminUser(actor);

      const resolvedName = input.name ?? input.displayName ?? input.email;
      const resolvedActive = resolveActiveStateInput(input) ?? true;
      const passwordHash = await hashPassword(input.password);

      const created = await usersRepo.createUser({
        id: generateId(),
        email: input.email,
        passwordHash,
        displayName: resolvedName,
        phone: input.phone ?? null,
        address: input.address ?? null,
        role: input.role,
        isActive: resolvedActive,
        deletedAt: resolvedActive ? null : new Date(),
      });

      return serializeUser(created);
    },

    async updateUserStatus(
      actor: AuthUser,
      targetUserId: string,
      input: UpdateUserStatusBody,
    ): Promise<PublicUser> {
      assertAdminUser(actor);
      const nextActive = resolveActiveStateInput(input);

      if (nextActive === false && actor.id === targetUserId) {
        throw new ConflictError('You cannot deactivate your own account', 'CANNOT_DEACTIVATE_SELF');
      }
      if (input.role === 'user' && actor.id === targetUserId) {
        throw new ConflictError('You cannot demote your own admin role', 'CANNOT_DEMOTE_SELF');
      }

      const existing = await usersRepo.findById(targetUserId);
      if (existing === null) {
        throw new NotFoundError('User not found', 'USER_NOT_FOUND');
      }

      const nextName = input.name ?? input.displayName;
      const now = new Date();
      const updated = await usersRepo.adminUpdateById(
        targetUserId,
        {
          ...(nextName !== undefined ? { displayName: nextName } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.address !== undefined ? { address: input.address } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(nextActive !== undefined
            ? {
                isActive: nextActive,
                deletedAt: nextActive ? null : (existing.deletedAt ?? now),
              }
            : {}),
        },
        now,
      );
      if (updated === null) {
        throw new NotFoundError('User not found', 'USER_NOT_FOUND');
      }

      return serializeUser(updated);
    },

    async deleteUser(actor: AuthUser, targetUserId: string): Promise<void> {
      assertAdminUser(actor);

      if (actor.id === targetUserId) {
        throw new ConflictError('You cannot deactivate your own account', 'CANNOT_DEACTIVATE_SELF');
      }

      const existing = await usersRepo.findById(targetUserId);
      if (existing === null) {
        throw new NotFoundError('User not found', 'USER_NOT_FOUND');
      }

      const now = new Date();
      const updated = await usersRepo.adminUpdateById(
        targetUserId,
        {
          isActive: false,
          deletedAt: existing.deletedAt ?? now,
        },
        now,
      );
      if (updated === null) {
        throw new NotFoundError('User not found', 'USER_NOT_FOUND');
      }
    },
  };
}
