import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { ForbiddenError } from '@/lib/errors.ts';
import { getRequiredUser } from '@/middlewares/auth.ts';
import type { AppEnv, AuthUser } from '@/types/app.ts';

export function assertAdminUser(actor: AuthUser): void {
  if (actor.role !== 'admin') {
    throw new ForbiddenError('Admin privileges required', 'ADMIN_REQUIRED');
  }
}

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const actor = getRequiredUser(c);
  assertAdminUser(actor);
  await next();
});

export function getRequiredAdmin(c: Context<AppEnv>): AuthUser {
  const actor = getRequiredUser(c);
  assertAdminUser(actor);
  return actor;
}
