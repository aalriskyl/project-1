import { env } from '@/config/env.ts';
import { logger } from '@/lib/logging/logger.ts';
import { ServiceUnavailableError } from '@/lib/shared/errors.ts';

export interface PasswordResetEmailInput {
  readonly to: string;
  readonly displayName: string;
  readonly resetUrl: string;
  readonly expiresInMinutes: number;
  readonly idempotencyKey?: string;
}

export interface InquiryEmailInput {
  readonly to: string;
  readonly replyTo: string;
  readonly subject: string;
  readonly text: string;
  readonly idempotencyKey?: string;
}

export interface MailProvider {
  sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void>;
  sendInquiryEmail(input: InquiryEmailInput): Promise<void>;
}

export interface ResendMailConfig {
  readonly apiKey?: string;
  readonly from: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
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
        throw new ServiceUnavailableError(
          'Email delivery is not configured',
          'MAIL_NOT_CONFIGURED',
        );
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

      const response = await (config.fetch ?? fetch)(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          ...(input.idempotencyKey !== undefined
            ? { 'Idempotency-Key': input.idempotencyKey }
            : {}),
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
        await response.body?.cancel();
        logger.error({ status: response.status }, 'resend password reset email failed');
        throw new ServiceUnavailableError(
          'Email provider rejected delivery',
          'MAIL_DELIVERY_FAILED',
        );
      }
    },

    async sendInquiryEmail(input: InquiryEmailInput): Promise<void> {
      if (config.apiKey === undefined) {
        throw new ServiceUnavailableError(
          'Email delivery is not configured',
          'MAIL_NOT_CONFIGURED',
        );
      }

      const response = await (config.fetch ?? fetch)(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          ...(input.idempotencyKey !== undefined
            ? { 'Idempotency-Key': input.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          from: config.from,
          to: [input.to],
          reply_to: input.replyTo,
          subject: input.subject,
          text: input.text,
        }),
        signal: AbortSignal.timeout(config.timeoutMs ?? MAIL_TIMEOUT_MS),
      });

      if (!response.ok) {
        await response.body?.cancel();
        logger.error({ status: response.status }, 'resend inquiry email failed');
        throw new ServiceUnavailableError(
          'Email provider rejected delivery',
          'MAIL_DELIVERY_FAILED',
        );
      }
    },
  };
}

export const mailProvider: MailProvider = createMailProvider();
