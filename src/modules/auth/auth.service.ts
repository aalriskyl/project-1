import { env } from '@/config/env.ts';
import { generateOpaqueToken, hashTokenSha256 } from '@/lib/crypto.ts';
import { ConflictError, UnauthorizedError } from '@/lib/errors.ts';
import { generateId } from '@/lib/id.ts';
import { type JwtConfig, signAccessToken } from '@/lib/jwt.ts';
import { hashPassword, verifyAgainstDummyPassword, verifyPassword } from '@/lib/password.ts';
import type { AuthRepository, NewRefreshTokenInput } from '@/modules/auth/auth.repository.ts';
import type {
  AuthSession,
  LoginBody,
  LogoutBody,
  RefreshBody,
  RegisterBody,
} from '@/modules/auth/auth.schema.ts';
import type { UserEntity } from '@/modules/users/users.repository.ts';
import { serializeUser } from '@/modules/users/users.service.ts';

export interface AuthServiceOptions {
  readonly refreshTokenTtlSec?: number;
  readonly jwtConfig?: JwtConfig;
}

export interface AuthService {
  register(input: RegisterBody): Promise<AuthSession>;
  login(input: LoginBody): Promise<AuthSession>;
  refresh(input: RefreshBody): Promise<AuthSession>;
  logout(input: LogoutBody): Promise<void>;
}

function buildRefreshTokenCandidate(
  userId: string,
  familyId: string,
  refreshTokenTtlSec: number,
  nowMs: number = Date.now(),
): {
  readonly rawRefreshToken: string;
  readonly record: NewRefreshTokenInput;
} {
  const rawRefreshToken = generateOpaqueToken();
  return {
    rawRefreshToken,
    record: {
      id: generateId(),
      userId,
      familyId,
      tokenHash: hashTokenSha256(rawRefreshToken),
      expiresAt: new Date(nowMs + refreshTokenTtlSec * 1000),
    },
  };
}

export function createAuthService(
  authRepo: AuthRepository,
  options: AuthServiceOptions = {},
): AuthService {
  const refreshTokenTtlSec = options.refreshTokenTtlSec ?? env.REFRESH_TOKEN_TTL_SEC;

  async function buildSessionResponse(
    user: UserEntity,
    rawRefreshToken: string,
  ): Promise<AuthSession> {
    const signedAccess = await signAccessToken(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      options.jwtConfig,
    );

    return {
      user: serializeUser(user),
      tokens: {
        accessToken: signedAccess.token,
        refreshToken: rawRefreshToken,
        tokenType: 'Bearer',
        expiresIn: signedAccess.expiresIn,
      },
    };
  }

  return {
    async register(input: RegisterBody): Promise<AuthSession> {
      const existing = await authRepo.findUserByEmailWithCredentials(input.email);
      if (existing !== null) {
        throw new ConflictError(
          'An account with this email already exists',
          'EMAIL_ALREADY_EXISTS',
        );
      }

      const passwordHash = await hashPassword(input.password);
      const userId = generateId();
      const familyId = generateId();
      const { rawRefreshToken, record } = buildRefreshTokenCandidate(
        userId,
        familyId,
        refreshTokenTtlSec,
      );

      const createdUser = await authRepo.createUserWithRefreshToken({
        user: {
          id: userId,
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          role: 'user',
        },
        refreshToken: record,
      });

      return buildSessionResponse(createdUser, rawRefreshToken);
    },

    async login(input: LoginBody): Promise<AuthSession> {
      const existing = await authRepo.findUserByEmailWithCredentials(input.email);
      if (existing === null) {
        await verifyAgainstDummyPassword(input.password);
        throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
      }

      const validPassword = await verifyPassword(input.password, existing.passwordHash);
      if (!validPassword) {
        throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
      }

      const familyId = generateId();
      const { rawRefreshToken, record } = buildRefreshTokenCandidate(
        existing.id,
        familyId,
        refreshTokenTtlSec,
      );

      await authRepo.insertRefreshToken(record);

      return buildSessionResponse(existing, rawRefreshToken);
    },

    async refresh(input: RefreshBody): Promise<AuthSession> {
      const tokenHash = hashTokenSha256(input.refreshToken);
      const found = await authRepo.findRefreshTokenWithUserByHash(tokenHash);

      if (found === null) {
        throw new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
      }

      const now = new Date();

      if (found.token.revokedAt !== null) {
        if (found.token.replacedByTokenId !== null) {
          // Replay of an already-rotated token compromises the entire session family.
          await authRepo.revokeTokenFamily(found.token.familyId, now);
          throw new UnauthorizedError(
            'Refresh token reuse detected; session revoked',
            'REFRESH_TOKEN_REUSED',
          );
        }
        throw new UnauthorizedError('Refresh token has been revoked', 'INVALID_REFRESH_TOKEN');
      }

      if (found.token.expiresAt.getTime() <= now.getTime()) {
        await authRepo.revokeTokenByHash(tokenHash, now);
        throw new UnauthorizedError('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
      }

      const { rawRefreshToken, record: nextToken } = buildRefreshTokenCandidate(
        found.user.id,
        found.token.familyId,
        refreshTokenTtlSec,
        now.getTime(),
      );

      const rotated = await authRepo.rotateRefreshToken({
        currentTokenId: found.token.id,
        nextToken,
        revokedAt: now,
      });

      if (!rotated) {
        await authRepo.revokeTokenFamily(found.token.familyId, now);
        throw new UnauthorizedError(
          'Refresh token reuse detected; session revoked',
          'REFRESH_TOKEN_REUSED',
        );
      }

      return buildSessionResponse(found.user, rawRefreshToken);
    },

    async logout(input: LogoutBody): Promise<void> {
      const tokenHash = hashTokenSha256(input.refreshToken);
      await authRepo.revokeTokenByHash(tokenHash, new Date());
    },
  };
}
