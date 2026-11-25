import { env } from '@/config/env.ts';
import { generateOpaqueToken, hashTokenSha256 } from '@/lib/crypto.ts';
import { ConflictError, ServiceUnavailableError, UnauthorizedError } from '@/lib/errors.ts';
import type { AuthUser } from '@/types/app.ts';
import { type GoogleTokenVerifier, googleTokenVerifier } from '@/lib/google-oauth.ts';
import { generateId } from '@/lib/id.ts';
import { type JwtConfig, signAccessToken } from '@/lib/jwt.ts';
import { type MailProvider } from '@/lib/mailer.ts';
import { encryptMail } from '@/lib/mail-outbox-crypto.ts';
import { hashPassword, verifyAgainstDummyPassword, verifyPassword } from '@/lib/password.ts';
import type { AuthRepository, NewRefreshTokenInput } from '@/modules/auth/auth.repository.ts';
import type {
  AuthSession,
  ForgotPasswordBody,
  GoogleLoginBody,
  LoginBody,
  LogoutBody,
  RefreshBody,
  RegisterBody,
  ResetPasswordBody,
} from '@/modules/auth/auth.schema.ts';
import type { UserEntity } from '@/modules/users/users.repository.ts';
import { serializeUser } from '@/modules/users/users.service.ts';

const GENERIC_FORGOT_PASSWORD_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

export interface AuthServiceOptions {
  readonly refreshTokenTtlSec?: number;
  readonly passwordResetTtlSec?: number;
  readonly appPublicUrl?: string;
  readonly jwtConfig?: JwtConfig;
  readonly googleVerifier?: GoogleTokenVerifier;
  readonly mailer?: MailProvider;
}

export interface AuthService {
  register(input: RegisterBody): Promise<AuthSession>;
  login(input: LoginBody): Promise<AuthSession>;
  googleLogin(input: GoogleLoginBody): Promise<AuthSession>;
  linkGoogle(actor: AuthUser, input: GoogleLoginBody): Promise<AuthSession>;
  forgotPassword(input: ForgotPasswordBody): Promise<{ readonly message: string }>;
  resetPassword(input: ResetPasswordBody): Promise<void>;
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
  const passwordResetTtlSec = options.passwordResetTtlSec ?? env.PASSWORD_RESET_TTL_SEC;
  const appPublicUrl = (options.appPublicUrl ?? env.APP_PUBLIC_URL).replace(/\/+$/, '');
  const googleVerifier = options.googleVerifier ?? googleTokenVerifier;
  const mailer = options.mailer;

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
          phone: input.phone ?? null,
          displayName: input.displayName,
          role: 'user',
        },
        refreshToken: record,
      });

      return buildSessionResponse(createdUser, rawRefreshToken);
    },

    async login(input: LoginBody): Promise<AuthSession> {
      const existing = await authRepo.findUserByEmailWithCredentials(input.email);
      if (existing === null || existing.passwordHash === null) {
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

    async googleLogin(input: GoogleLoginBody): Promise<AuthSession> {
      const identity = await googleVerifier.verifyIdToken(input.idToken);

      const existingBySub = await authRepo.findUserByGoogleSub(identity.sub);
      if (existingBySub !== null) {
        const familyId = generateId();
        const { rawRefreshToken, record } = buildRefreshTokenCandidate(
          existingBySub.id,
          familyId,
          refreshTokenTtlSec,
        );
        await authRepo.insertRefreshToken(record);
        return buildSessionResponse(existingBySub, rawRefreshToken);
      }

      const existingByEmail = await authRepo.findUserByEmailWithCredentials(identity.email);
      if (existingByEmail !== null) {
        throw new ConflictError(
          'Sign in to your existing account before linking Google',
          'GOOGLE_LINK_REQUIRED',
        );
      }

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
          email: identity.email,
          passwordHash: null,
          googleSub: identity.sub,
          displayName: identity.displayName,
          role: 'user',
        },
        refreshToken: record,
      });

      return buildSessionResponse(createdUser, rawRefreshToken);
    },

    async linkGoogle(actor: AuthUser, input: GoogleLoginBody): Promise<AuthSession> {
      const identity = await googleVerifier.verifyIdToken(input.idToken);
      const existing = await authRepo.findUserByEmailWithCredentials(identity.email);
      if (existing === null || existing.id !== actor.id) {
        throw new ConflictError(
          'Google email must match the authenticated account',
          'GOOGLE_ACCOUNT_MISMATCH',
        );
      }
      const { rawRefreshToken, record } = buildRefreshTokenCandidate(
        actor.id,
        generateId(),
        refreshTokenTtlSec,
      );
      const linked = await authRepo.linkGoogleSubAndInsertRefreshToken({
        userId: actor.id,
        googleSub: identity.sub,
        refreshToken: record,
      });
      return buildSessionResponse(linked, rawRefreshToken);
    },

    async forgotPassword(input: ForgotPasswordBody): Promise<{ readonly message: string }> {
      if (
        mailer === undefined &&
        (env.MAIL_OUTBOX_ENCRYPTION_KEY === undefined || env.RESEND_API_KEY === undefined)
      )
        throw new ServiceUnavailableError(
          'Password reset email is not configured',
          'MAIL_NOT_CONFIGURED',
        );
      const existing = await authRepo.findUserByEmailWithCredentials(input.email);
      if (existing === null) {
        return { message: GENERIC_FORGOT_PASSWORD_MESSAGE };
      }

      const rawResetToken = generateOpaqueToken();
      const tokenHash = hashTokenSha256(rawResetToken);
      const expiresAt = new Date(Date.now() + passwordResetTtlSec * 1000);

      const id = generateId();
      const resetUrl = `${appPublicUrl}/auth/reset-password?token=${encodeURIComponent(rawResetToken)}`;
      const email = {
        to: existing.email,
        displayName: existing.displayName,
        resetUrl,
        expiresInMinutes: Math.max(1, Math.round(passwordResetTtlSec / 60)),
      };
      const delivery =
        mailer === undefined && env.MAIL_OUTBOX_ENCRYPTION_KEY !== undefined
          ? { id, payload: await encryptMail(email, env.MAIL_OUTBOX_ENCRYPTION_KEY), expiresAt }
          : undefined;
      await authRepo.createPasswordResetToken(
        {
          id,
          userId: existing.id,
          tokenHash,
          expiresAt,
        },
        delivery,
      );
      if (mailer !== undefined) await mailer.sendPasswordResetEmail(email);

      return { message: GENERIC_FORGOT_PASSWORD_MESSAGE };
    },

    async resetPassword(input: ResetPasswordBody): Promise<void> {
      const tokenHash = hashTokenSha256(input.token);
      const passwordHash = await hashPassword(input.newPassword);

      const consumed = await authRepo.consumePasswordResetTokenAndUpdatePassword({
        tokenHash,
        passwordHash,
        now: new Date(),
      });

      if (!consumed) {
        throw new UnauthorizedError(
          'Invalid or expired password reset token',
          'INVALID_RESET_TOKEN',
        );
      }
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
