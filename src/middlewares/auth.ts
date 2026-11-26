import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { ForbiddenError, UnauthorizedError } from '@/lib/errors.ts';
import { type JwtConfig, verifyAccessToken } from '@/lib/jwt.ts';
import { isRecordActive } from '@/lib/status.ts';
import type { AppEnv, AuthUser, UserRole } from '@/types/app.ts';

const BEARER_PREFIX = 'Bearer ';

export interface ActiveSessionUserState {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly deletedAt: Date | null;
  readonly tokenVersion: number;
}

export type SessionUserResolver = (userId: string) => Promise<ActiveSessionUserState | null>;

export interface AuthMiddlewareOptions {
  readonly jwtConfig?: JwtConfig;
  readonly resolveSessionUser?: SessionUserResolver;
}

export function createAuthMiddleware(optionsOrJwtConfig?: AuthMiddlewareOptions | JwtConfig) {
  const jwtConfig =
    optionsOrJwtConfig !== undefined && 'secret' in optionsOrJwtConfig
      ? optionsOrJwtConfig
      : optionsOrJwtConfig?.jwtConfig;
  const resolveSessionUser =
    optionsOrJwtConfig !== undefined && 'resolveSessionUser' in optionsOrJwtConfig
      ? optionsOrJwtConfig.resolveSessionUser
      : undefined;

  return createMiddleware<AppEnv>(async (c, next) => {
    const authHeader = c.req.header('authorization');
    if (authHeader === undefined || !authHeader.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedError('Missing or malformed Authorization header', 'MISSING_TOKEN');
    }

    const rawToken = authHeader.slice(BEARER_PREFIX.length).trim();
    if (rawToken.length === 0) {
      throw new UnauthorizedError('Missing bearer token', 'MISSING_TOKEN');
    }

    const claims = await verifyAccessToken(rawToken, jwtConfig);

    if (resolveSessionUser !== undefined) {
      const liveUser = await resolveSessionUser(claims.id);
      if (liveUser === null) {
        throw new UnauthorizedError('Invalid or expired access token', 'INVALID_TOKEN');
      }
      if (!isRecordActive(liveUser)) {
        throw new ForbiddenError('This account has been deactivated', 'ACCOUNT_INACTIVE');
      }
      if (liveUser.tokenVersion !== (claims.tokenVersion ?? 1)) {
        throw new UnauthorizedError('Access token has been revoked', 'TOKEN_REVOKED');
      }
      c.set('user', {
        id: liveUser.id,
        email: liveUser.email,
        role: liveUser.role,
        tokenVersion: liveUser.tokenVersion,
      });
    } else {
      c.set('user', claims);
    }

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
