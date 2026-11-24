import { verifyWithJwks } from 'hono/jwt';
import { z } from 'zod';
import { env } from '@/config/env.ts';
import { ServiceUnavailableError, UnauthorizedError } from '@/lib/errors.ts';

const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUER_PATTERN = /^(https:\/\/)?accounts\.google\.com$/;
const GOOGLE_JWKS_TIMEOUT_MS = 5_000;

const GoogleClaimsSchema = z.object({
  sub: z.string().min(1).max(128),
  email: z.email(),
  email_verified: z.boolean(),
  name: z.string().min(1).max(120).optional(),
});

export interface GoogleIdentity {
  readonly sub: string;
  readonly email: string;
  readonly displayName: string;
}

export interface GoogleTokenVerifier {
  verifyIdToken(idToken: string): Promise<GoogleIdentity>;
}

export function createGoogleTokenVerifier(
  clientId: string | undefined = env.GOOGLE_OAUTH_CLIENT_ID,
): GoogleTokenVerifier {
  return {
    async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
      if (clientId === undefined) {
        throw new ServiceUnavailableError(
          'Google Sign-In is not configured (missing GOOGLE_OAUTH_CLIENT_ID)',
          'OAUTH_NOT_CONFIGURED',
        );
      }

      let rawPayload: unknown;
      try {
        rawPayload = await verifyWithJwks(
          idToken,
          {
            jwks_uri: GOOGLE_JWKS_URI,
            allowedAlgorithms: ['RS256'],
            verification: {
              iss: GOOGLE_ISSUER_PATTERN,
              aud: clientId,
              exp: true,
              iat: true,
            },
          },
          { signal: AbortSignal.timeout(GOOGLE_JWKS_TIMEOUT_MS) },
        );
      } catch {
        throw new UnauthorizedError('Invalid or expired Google ID token', 'INVALID_GOOGLE_TOKEN');
      }

      const parsed = GoogleClaimsSchema.safeParse(rawPayload);
      if (!parsed.success || !parsed.data.email_verified) {
        throw new UnauthorizedError(
          'Google account email must be verified',
          'UNVERIFIED_GOOGLE_EMAIL',
        );
      }

      const normalizedEmail = parsed.data.email.trim().toLowerCase();
      const fallbackName = normalizedEmail.split('@')[0] ?? 'User';

      return {
        sub: parsed.data.sub,
        email: normalizedEmail,
        displayName: parsed.data.name?.trim() || fallbackName,
      };
    },
  };
}

export const googleTokenVerifier: GoogleTokenVerifier = createGoogleTokenVerifier();
