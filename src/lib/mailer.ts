import { env } from '@/config/env.ts';
import { logger } from '@/lib/logger.ts';

export interface PasswordResetEmailInput {
  readonly to: string;
  readonly displayName: string;
  readonly resetUrl: string;
  readonly expiresInMinutes: number;
}

export interface MailProvider {
  sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void>;
}

export interface ResendMailConfig {
  readonly apiKey?: string;
  readonly from: string;
  readonly timeoutMs?: number;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAIL_TIMEOUT_MS = 6_000;

/**
 * Transactional email adapter.
 * Uses Resend HTTPS API when `RESEND_API_KEY` is configured; falls back to a redacted
 * structured log event in development/test (never logging the raw reset URL or token).
 */
export function createMailProvider(
  config: ResendMailConfig = {
    ...(env.RESEND_API_KEY !== undefined ? { apiKey: env.RESEND_API_KEY } : {}),
    from: env.MAIL_FROM,
  },
): MailProvider {
  return {
    async sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
      if (config.apiKey === undefined) {
        logger.info(
          {
            recipient: input.to,
            expiresInMinutes: input.expiresInMinutes,
          },
          'RESEND_API_KEY not set; skipped outbound password reset email dispatch',
        );
        return;
      }

      const subject = 'Reset your Tsuzumi Japan password';
      const text = [
        `Hello ${input.displayName},`,
        '',
        `Use the link below to reset your password (valid for ${input.expiresInMinutes} minutes):`,
        input.resetUrl,
        '',
        'If you did not request this, you can safely ignore this email.',
      ].join('\n');

      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.from,
          to: [input.to],
          subject,
          text,
        }),
        signal: AbortSignal.timeout(config.timeoutMs ?? MAIL_TIMEOUT_MS),
      });

      if (!response.ok) {
        logger.error(
          { status: response.status, recipient: input.to },
          'resend password reset email failed',
        );
      }
    },
  };
}

export const mailProvider: MailProvider = createMailProvider();
