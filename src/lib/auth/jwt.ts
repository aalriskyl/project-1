import { sign, verify } from 'hono/jwt';
import { z } from 'zod';
import { env } from '@/config/env.ts';
import { UnauthorizedError } from '@/lib/shared/errors.ts';
import { generateId } from '@/lib/auth/id.ts';
import { type AuthUser, USER_ROLES } from '@/types/app.ts';

const PINNED_JWT_ALGORITHM = 'HS256' as const;
const MAX_CLOCK_SKEW_SEC = 5;

const AccessTokenClaimsSchema = z.object({
  sub: z.uuid(),
  email: z.email(),
  role: z.enum(USER_ROLES),
  tv: z.number().int().positive().default(1),
  iss: z.string(),
  aud: z.string(),
  iat: z.number(),
  exp: z.number(),
  jti: z.string(),
});

export interface JwtConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly accessTtlSec: number;
}

const defaultJwtConfig: JwtConfig = {
  secret: env.JWT_ACCESS_SECRET,
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
  accessTtlSec: env.JWT_ACCESS_TTL_SEC,
};

export interface SignedAccessToken {
  readonly token: string;
  readonly expiresIn: number;
}

export async function signAccessToken(
  user: AuthUser,
  config: JwtConfig = defaultJwtConfig,
): Promise<SignedAccessToken> {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + config.accessTtlSec;

  const token = await sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      tv: user.tokenVersion ?? 1,
      iss: config.issuer,
      aud: config.audience,
      iat: nowSec,
      exp: expSec,
      jti: generateId(),
    },
    config.secret,
    PINNED_JWT_ALGORITHM,
  );

  return {
    token,
    expiresIn: config.accessTtlSec,
  };
}

export async function verifyAccessToken(
  token: string,
  config: JwtConfig = defaultJwtConfig,
): Promise<AuthUser> {
  let payload: unknown;
  try {
    payload = await verify(token, config.secret, {
      alg: PINNED_JWT_ALGORITHM,
      iss: config.issuer,
      aud: config.audience,
      exp: true,
      iat: false,
    });
  } catch {
    throw new UnauthorizedError('Invalid or expired access token', 'INVALID_TOKEN');
  }

  const parsed = AccessTokenClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UnauthorizedError('Malformed access token claims', 'INVALID_TOKEN');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (parsed.data.iat > nowSec + MAX_CLOCK_SKEW_SEC) {
    throw new UnauthorizedError('Invalid or expired access token', 'INVALID_TOKEN');
  }

  return {
    id: parsed.data.sub,
    email: parsed.data.email,
    role: parsed.data.role,
    tokenVersion: parsed.data.tv,
  };
}
