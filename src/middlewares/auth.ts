import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { UnauthorizedError } from '@/lib/errors.ts';
import { type JwtConfig, verifyAccessToken } from '@/lib/jwt.ts';
import type { AppEnv, AuthUser } from '@/types/app.ts';

const BEARER_PREFIX = 'Bearer ';

export function createAuthMiddleware(jwtConfig?: JwtConfig) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const authHeader = c.req.header('authorization');
    if (authHeader === undefined || !authHeader.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedError('Missing or malformed Authorization header', 'MISSING_TOKEN');
    }

    const rawToken = authHeader.slice(BEARER_PREFIX.length).trim();
    if (rawToken.length === 0) {
      throw new UnauthorizedError('Missing bearer token', 'MISSING_TOKEN');
    }

    const user = await verifyAccessToken(rawToken, jwtConfig);
    c.set('user', user);

    await next();
  });
}

export const requireAuth = createAuthMiddleware();

export function getRequiredUser(c: Context<AppEnv>): AuthUser {
  const user = c.get('user');
  if (user === undefined) {
    throw new UnauthorizedError();
  }
  return user;
}
